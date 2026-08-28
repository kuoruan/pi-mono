/**
 * Model call: ask the reviewer model to assess a permission request.
 *
 * {@link reviewModel} is the single entry point — it takes a resolved
 * {@link ModelCallContext} (model + auth + call config) and the prompt pair,
 * runs `completeSimple`, and returns a {@link ReviewOutcome}. The call
 * machinery (AbortSignal, auth headers, maxTokens, reasoning, error
 * classification) is private to this module.
 *
 * Fail-safe — all errors (timeout, unparseable reply, thrown) resolve to
 * defer. Verdict is extracted from the model's JSON text reply; the prompt is
 * the primary enforcement mechanism. Call failures and diagnostics land in
 * the same audit log as the decision record (keyed by `requestId`).
 */

import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  contentText,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";

import type { AiGuardConfig } from "./config-schema.ts";
import { MODEL_CALL_ERROR_EVENT, MODEL_REPLY_EVENT, modelCallError } from "./decision-record.ts";
import {
  type ModelCallDeferKind,
  type ReviewOutcome,
  type ReviewOutcomeDiagnostic,
  parseTextFallback,
} from "./model-verdict.ts";
import { normalizeAndRedactText } from "./utils.ts";

/**
 * Auth result from `ModelRegistry.getApiKeyAndHeaders`, derived from the
 * upstream return type (not exported from the package root).
 */
export type ResolvedRequestAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

/** Model completion function signature (wraps `provider.streamSimple().result()`). */
export type CompleteSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/**
 * Minimal structural projection of the pi-coding-agent `ModelRegistry` needed
 * by this extension. Defined as a `Pick` of the real class instance type so
 * the accepted method set tracks the package's exported shape instead of a
 * hand-written interface that can silently diverge.
 */
export type ModelRegistryLike = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders" | "getProvider">;

/**
 * Result of the shared call scaffolding in {@link executeCall}.
 * Success carries the raw assistant reply; failure carries the classified
 * defer kind. Both carry latency so the public methods can populate their
 * outcome shapes without re-timing.
 */
type CallResult =
  | { ok: true; reply: AssistantMessage; latencyMs: number }
  | { ok: false; deferKind: ModelCallDeferKind; latencyMs: number };

/**
 * Resolved auth fields needed to make a model call. Extracted from
 * {@link ResolvedRequestAuth} after the pipeline's auth gate has passed.
 */
export type ModelCallAuth = Pick<SimpleStreamOptions, "apiKey" | "headers">;

/**
 * Everything a model review call needs, captured once. The pipeline builds
 * this from its resolved model + auth + call context; {@link reviewModel}
 * consumes it.
 */
export interface ModelCallContext {
  /** The resolved reviewer model. */
  model: Model<Api>;
  /** Model completion function (wraps `provider.streamSimple().result()`). */
  completeSimple: CompleteSimpleFn;
  /** Resolved auth fields for the call. */
  auth: ModelCallAuth;
  /** Reasoning level ("off" omits the option). */
  reasoning: AiGuardConfig["reasoning"];
  /** Reply budget — thinking blocks count against it on reasoning upstreams. */
  maxTokens: number;
  /** Audit log for call-failure and diagnostic records. */
  log: AuthorizerLog;
  /** Request id for audit-log correlation. */
  requestId: string;
}

/**
 * Build a non-deprecated model completer on top of `ModelRegistry.getProvider`.
 *
 * Uses `provider.streamSimple(...).result()` instead of the deprecated
 * `@earendil-works/pi-ai/compat` `completeSimple` entrypoint. The caller is
 * responsible for resolving auth (`getApiKeyAndHeaders`) and passing the
 * resulting apiKey/headers into options.
 *
 * @param getRegistry - Function returning the model registry (or undefined if unavailable).
 * @returns A `CompleteSimpleFn` that completes a model call via `provider.streamSimple`.
 */
export function createCompleteSimple(
  getRegistry: () => ModelRegistryLike | undefined,
): CompleteSimpleFn {
  return async (model, context, options) => {
    const registry = getRegistry();
    const provider = registry?.getProvider(model.provider);
    if (!provider) {
      throw new Error(`No provider registered for "${model.provider}"`);
    }
    const stream = provider.streamSimple(model, context, options);
    return stream.result();
  };
}

/**
 * Emit a call-failure record to the audit log (keyed by requestId).
 *
 * @param ctx - The resolved model-call context (for log + requestId).
 * @param deferKind - The classified defer kind.
 * @param error - The thrown error.
 */
function reportCallFailure(
  ctx: ModelCallContext,
  deferKind: ModelCallDeferKind,
  error: unknown,
): void {
  const rawError = error instanceof Error ? error.message : String(error);
  ctx.log.debug(
    MODEL_CALL_ERROR_EVENT,
    modelCallError(ctx.requestId, deferKind, normalizeAndRedactText(rawError)),
  );
}

/**
 * Shared call scaffolding for {@link reviewModel}: builds the context +
 * options, runs `completeSimple`, and normalizes a thrown error into a defer
 * reason. {@link reviewModel} owns the parser and the outcome-shape mapping;
 * this owns the call machinery — AbortSignal, auth headers, maxTokens,
 * reasoning, and the timeout/call-failed classification.
 *
 * @param ctx - The resolved model-call context.
 * @param systemPrompt - The system prompt for the call.
 * @param userPrompt - The user prompt for the call.
 * @param timeoutMs - Per-call timeout in milliseconds.
 * @param maxTokens - Maximum tokens for the model reply.
 * @param providerRetries - Pi-ai provider-layer retries for this call
 *   (attempt 1 passes 1; the empty-reply retry passes 0 — see reviewModel).
 * @returns A `CallResult`: success with the reply, or failure with the classified defer reason.
 */
async function executeCall(
  ctx: ModelCallContext,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  maxTokens: number,
  providerRetries: number,
): Promise<CallResult> {
  // The Authorizer callback receives no ExtensionContext, so the agent's
  // ctx.signal can't be threaded here; this timeout is the only abort source.
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = Date.now();
  try {
    const context: Context = {
      systemPrompt,
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
    };
    const options: SimpleStreamOptions = {
      signal,
      apiKey: ctx.auth.apiKey,
      headers: ctx.auth.headers,
      maxTokens,
      // Provider-level retry (429/408/409/5xx per pi-ai's classifier,
      // backoff and retry-after honored) — the signal spans every attempt,
      // so timeoutMs stays the TOTAL budget, retries included. The
      // empty-reply retry in reviewModel passes 0: that call is itself the
      // retry budget being spent, and a provider error there has none left
      // (max 3 requests per review — see the retry loop in reviewModel).
      maxRetries: providerRetries,
    };
    // reasoning: "off" → don't pass reasoning option → pi-ai sets
    // thinkingEnabled: false → sends thinking: {type: "disabled"}.
    // Non-off values pass through as the reasoning level.
    if (ctx.reasoning && ctx.reasoning !== "off") {
      options.reasoning = ctx.reasoning;
    }
    const reply = await ctx.completeSimple(ctx.model, context, options);
    return { ok: true, reply, latencyMs: Date.now() - startedAt };
  } catch (e) {
    const deferKind: ModelCallDeferKind =
      e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")
        ? "timeout"
        : "call-failed";
    reportCallFailure(ctx, deferKind, e);
    return { ok: false, deferKind, latencyMs: Date.now() - startedAt };
  }
}

/**
 * Review one permission request with the model and return the structured
 * outcome. Fail-safe: timeout, unparseable reply, or thrown → defer.
 *
 * @param ctx - The resolved model-call context (model, auth, call config).
 * @param systemPrompt - The system prompt for the review call.
 * @param userPrompt - The user prompt containing the permission request.
 * @param timeoutMs - Per-call timeout in milliseconds.
 * @returns A `ReviewOutcome` with the parsed verdict, or a defer outcome on failure.
 */
export async function reviewModel(
  ctx: ModelCallContext,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<ReviewOutcome> {
  // Attempt 1: provider-level retries enabled (maxRetries: 1 in pi-ai —
  // its classifier, backoff, and retry-after handling apply; the signal
  // spans them, so timeoutMs is the total budget). Up to 2 HTTP requests
  // live inside this one executeCall.
  const result = await executeCall(ctx, systemPrompt, userPrompt, timeoutMs, ctx.maxTokens, 1);
  if (!result.ok) {
    // Provider errors do NOT re-fire here — pi-ai's retry budget is
    // already spent inside executeCall; this loop only owns the
    // empty-reply retry.
    return {
      verdict: { kind: "defer" },
      deferKind: result.deferKind,
      latencyMs: result.latencyMs,
    };
  }

  // Empty-reply retry: a 200 with no usable text (e.g. an always-thinking
  // upstream spending the whole budget on reasoning) is invisible to
  // pi-ai's HTTP-layer retry — reviewModel owns it. Gate: only when the
  // first attempt consumed less than half the window, so the retry always
  // has at least half a window to run in; its budget is the REMAINING
  // time (timeoutMs − elapsed), keeping timeoutMs a total-budget promise.
  const retryOnEmpty = async (): Promise<CallResult> =>
    executeCall(
      ctx,
      systemPrompt,
      userPrompt,
      // The retry's own budget: remaining window, min 1ms guard.
      Math.max(1, timeoutMs - result.latencyMs),
      ctx.maxTokens,
      // No provider retry on the retry: this call IS the retry budget —
      // a provider error here fails straight to call-failed (deliberately
      // less robust than attempt 1, whose budget is spent).
      0,
    );

  // Parse the verdict from the model's text reply as JSON.
  let text = contentText(result.reply.content, "");
  if (!text.trim() && result.latencyMs < timeoutMs / 2) {
    // The first attempt's empty diagnostic goes to the debug stream here:
    // the retry replaces the reply, and without this line the first
    // stopReason/contentTypes would be lost (the review stream keeps the
    // `attempts: 2` fact; this keeps the debug-level why).
    logEmptyDiagnostic(ctx, result, 1);
    const second = await retryOnEmpty();
    if (second.ok) {
      // Either attempt's usable text wins; the retry's latency
      // accumulates into the reported latencyMs (the review's total cost).
      const secondText = contentText(second.reply.content, "");
      const base = {
        ...result,
        reply: second.reply,
        latencyMs: result.latencyMs + second.latencyMs,
      };
      if (secondText.trim()) {
        return { ...parseTextFallback(secondText, base.latencyMs), attempts: 2 };
      }
      return classifyEmptyReply(ctx, base, 2);
    }
    // The retry itself failed (provider error on a budgetless attempt, or
    // its remaining-window timeout): classify from the SECOND failure —
    // it is the freshest failure and the one the operator waited on.
    return {
      verdict: { kind: "defer" },
      deferKind: second.deferKind,
      latencyMs: result.latencyMs + second.latencyMs,
      attempts: 2,
    };
  }
  if (text.trim()) {
    return parseTextFallback(text, result.latencyMs);
  }
  // Empty-response diagnostic: log stopReason/contentTypes/errorMessage to
  // distinguish provider errors from genuine empty content.
  //
  // AbortSignal.timeout() does NOT throw — the Anthropic provider catches
  // the abort, resolves the stream with an empty AssistantMessage whose
  // stopReason is "aborted". Detect that here and classify as "timeout"
  // instead of "empty-reply" so the two root causes are distinguishable in
  // telemetry. Local-timeout-classified outcomes never enter the retry
  // loop (their latency already consumed the whole window); a server-side
  // early abort can still retry — most of the window is unspent.
  return classifyEmptyReply(ctx, result);
}

/**
 * Log an empty-reply diagnostic to the debug stream — the why behind a
 * textless reply (stopReason, content types, error message). Shared by
 * the retry path (first attempt's diagnostic, before it is replaced) and
 * {@link classifyEmptyReply}.
 *
 * @param ctx - The resolved model-call context (log target).
 * @param result - The successful call whose reply carried no text.
 * @param attempts - How many executeCall attempts produced this reply.
 * @returns The diagnostic payload (also returned by the caller for the
 * decision record).
 */
function logEmptyDiagnostic(
  ctx: ModelCallContext,
  result: CallResult & { ok: true },
  attempts?: number,
): ReviewOutcomeDiagnostic {
  const diagnostic: ReviewOutcomeDiagnostic = {
    stopReason: result.reply.stopReason ?? null,
    rawStopReason: result.reply.rawStopReason ?? null,
    errorMessage: result.reply.errorMessage
      ? normalizeAndRedactText(result.reply.errorMessage)
      : null,
    contentTypes: Array.isArray(result.reply.content)
      ? result.reply.content.map((b) =>
          typeof b === "object" && b !== null && "type" in b
            ? (b as { type: string }).type
            : typeof b,
        )
      : [],
  };
  ctx.log.debug(MODEL_REPLY_EVENT, {
    requestId: ctx.requestId,
    diagnostic: true,
    ...diagnostic,
    latencyMs: result.latencyMs,
    ...(attempts === undefined ? {} : { attempts }),
  });
  return diagnostic;
}

/**
 * Classify an empty (no usable text) reply into the diagnostic defer
 * outcome: timeout when the stream was aborted, empty-reply otherwise.
 * Logs the debug diagnostic via {@link logEmptyDiagnostic}; shared by
 * the first attempt and the empty-reply retry.
 *
 * @param ctx - The resolved model-call context (log target).
 * @param result - The successful call whose reply carried no text.
 * @param attempts - How many executeCall attempts produced this outcome.
 * @returns The defer outcome with the empty-reply diagnostic attached.
 */
function classifyEmptyReply(
  ctx: ModelCallContext,
  result: CallResult & { ok: true },
  attempts?: number,
): ReviewOutcome {
  const stopReason = result.reply.stopReason ?? null;
  const isTimeout = stopReason === "aborted";
  const diagnostic = logEmptyDiagnostic(ctx, result, attempts);

  return {
    verdict: { kind: "defer" },
    deferKind: isTimeout ? "timeout" : "empty-reply",
    latencyMs: result.latencyMs,
    ...(attempts === undefined ? {} : { attempts }),
    // Ride the outcome into the decision record: the review log itself
    // then shows WHY the reply was empty, independent of the permission
    // system's debug-log toggle.
    diagnostic,
  };
}
