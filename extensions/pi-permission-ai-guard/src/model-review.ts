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
 * the primary enforcement mechanism. When an `AuthorizerLog` is passed, call
 * failures land in the same audit log as the decision record (keyed by
 * `requestId`); otherwise they fall back to `console.warn`.
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
import { MODEL_CALL_ERROR_EVENT, MODEL_REPLY_EVENT } from "./decision-record.ts";
import { warn } from "./logger.ts";
import { type ModelCallDeferReason, type ReviewOutcome, parseTextFallback } from "./verdict.ts";

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
 * defer reason. Both carry latency so the public methods can populate their
 * outcome shapes without re-timing.
 */
export type CallResult =
  | { ok: true; reply: AssistantMessage; latencyMs: number }
  | { ok: false; reason: ModelCallDeferReason; latencyMs: number };

/** Enough for a JSON verdict with a short reason. */
const REVIEW_MAX_TOKENS = 512;

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
 * Resolved auth fields needed to make a model call. Extracted from
 * {@link ResolvedRequestAuth} after the pipeline's auth gate has passed.
 */
export interface ModelCallAuth {
  /** The API key for the model provider. */
  apiKey: string | undefined;
  /** Extra HTTP headers for the model call. */
  headers: Record<string, string> | undefined;
}

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
  /** Audit log for call-failure records (optional — falls back to console.warn). */
  log: AuthorizerLog | undefined;
  /** Request id for audit-log correlation. */
  requestId: string | undefined;
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
  const result = await executeCall(ctx, systemPrompt, userPrompt, timeoutMs, REVIEW_MAX_TOKENS);
  if (!result.ok) {
    return {
      verdict: { kind: "defer" },
      deferReason: result.reason,
      latencyMs: result.latencyMs,
    };
  }
  // Parse the verdict from the model's text reply as JSON.
  const text = contentText(result.reply.content, "");
  if (text.trim()) {
    return parseTextFallback(text, result.latencyMs);
  }
  // Empty-response diagnostic: log stopReason/contentTypes/errorMessage to
  // distinguish provider errors from genuine empty content. Temporary —
  // remove once the intermittent empty-response root cause is identified.

  ctx.log?.debug(MODEL_REPLY_EVENT, {
    requestId: ctx.requestId,
    diagnostic: true,
    stopReason: result.reply.stopReason ?? null,
    rawStopReason: result.reply.rawStopReason ?? null,
    errorMessage: result.reply.errorMessage ?? null,
    contentTypes: Array.isArray(result.reply.content)
      ? result.reply.content.map((b) =>
          typeof b === "object" && b !== null && "type" in b
            ? (b as { type: string }).type
            : typeof b,
        )
      : [],
    latencyMs: result.latencyMs,
  });

  return {
    verdict: { kind: "defer" },
    deferReason: "empty-reply",
    latencyMs: result.latencyMs,
  };
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
 * @returns A `CallResult`: success with the reply, or failure with the classified defer reason.
 */
async function executeCall(
  ctx: ModelCallContext,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
  maxTokens: number,
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
    const reason: ModelCallDeferReason =
      e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")
        ? "timeout"
        : "call-failed";
    reportCallFailure(ctx, reason, e);
    return { ok: false, reason, latencyMs: Date.now() - startedAt };
  }
}

/**
 * Emit a call-failure record: to the audit log when present (keyed by
 * requestId), otherwise console.warn.
 *
 * @param ctx - The resolved model-call context (for log + requestId).
 * @param reason - The classified defer reason.
 * @param error - The thrown error.
 */
function reportCallFailure(ctx: ModelCallContext, reason: string, error: unknown): void {
  const message = `review call failed (${reason}): ${error instanceof Error ? error.message : String(error)}`;
  if (ctx.log) {
    ctx.log.debug(MODEL_CALL_ERROR_EVENT, {
      requestId: ctx.requestId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  warn(message);
}
