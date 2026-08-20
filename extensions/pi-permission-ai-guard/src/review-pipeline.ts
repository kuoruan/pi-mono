/**
 * ReviewPipeline: the deep module behind the AI Guard chain link.
 *
 * The interface is `Authorizer["authorize"]` (the upstream seam);
 * `ReviewPipelineDeps` is a construction parameter, not the interface. Session
 * state is captured by closure at construction time.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Authorizer } from "@gotgenes/pi-permission-system";

import { buildAskContext, resolveReviewTarget } from "./ask-eligibility.ts";
import type { AiGuardConfig, Mode } from "./config-schema.ts";
import {
  BREAKER_DENY_REASON,
  CACHE_LOOKUP_EVENT,
  DECISION_EVENT,
  DecisionRecord,
  MODEL_REPLY_EVENT,
  SHORT_CIRCUIT_EVENT,
  cacheLookup,
  mapped,
  modelReply,
  shortCircuit,
} from "./decision-record.ts";
import {
  type CompleteSimpleFn,
  type ModelCallContext,
  type ModelRegistryLike,
  type ResolvedRequestAuth,
  reviewModel,
} from "./model-review.ts";
import { buildReviewPrompt, buildReviewSystemPrompt } from "./prompt.ts";
import { reviewRequestCacheMaterial, type ReviewRequestContext } from "./review-request.ts";
import type { CircuitBreaker, SessionOverrides, VerdictCache } from "./session-state.ts";
import { type SessionManagerLike, stripTranscript } from "./transcript-stripper.ts";
import { normalizeAndRedactText } from "./utils.ts";
import {
  applyVerdictMode,
  type MachineryFailureKind,
  machineryDeferMessage,
  manualEscalationMessage,
} from "./verdict-mode.ts";

/**
 * Fire-and-forget user notification — the host UI context's own notify
 * signature (the extension wraps ctx.ui.notify; absent in headless tests
 * and when no UI context was captured).
 */
export type NotifyFn = ExtensionUIContext["notify"];

/**
 * Resolved session state, captured once at construction. Not a lazy
 * dependency bag — every field is a direct value the pipeline closes over.
 */
export interface ReviewPipelineDeps {
  /** Validated extension config. */
  config: AiGuardConfig;
  /** Model registry — resolves the reviewer model. */
  registry: ModelRegistryLike;
  /** Session manager for transcript stripping (trusted intent + tool calls). */
  sessionManager: SessionManagerLike;
  /** Session working directory (from session_start); the policy boundary. */
  cwd: string;
  /** Per-session circuit breaker — trips on consecutive denials. */
  circuitBreaker: CircuitBreaker;
  /** Per-session verdict cache — avoids re-reviewing identical commands. */
  verdictCache: VerdictCache;
  /** Session-scoped runtime overrides (/ai-guard, ctrl+alt+g); consulted before config. */
  overrides: SessionOverrides;
  /** Model call function (wrapped provider.streamSimple().result()). */
  completeSimple: CompleteSimpleFn;
  /** Best-effort human notification for verdicts that escalate to the user. */
  notify?: NotifyFn;
}

/**
 * Build the AI Guard authorizer from resolved session state. The returned
 * `authorize` function is the upstream `Authorizer["authorize"]` seam — the
 * only interface callers (extension.ts) and tests cross.
 *
 * @param deps - The resolved session-state dependencies for the pipeline.
 * @returns The `authorize` function implementing the review pipeline.
 */
/**
 * Auto mode's machinery-escape contract: the human is about to see an
 * interruption they didn't opt into (reviewer broken, not uncertain), so
 * explain it. Pre-call paths (model unresolved, auth failed, transcript
 * errors) defer before any mode mapping, but the contract is the same —
 * the notify fires in auto mode only.
 *
 * @param deps - The pipeline dependencies (notify is optional).
 * @param mode - The effective mode (the notify fires in auto mode only).
 * @param kind - The machinery failure kind for the message.
 */
function notifyMachineryEscape(
  deps: ReviewPipelineDeps,
  mode: Mode,
  kind: MachineryFailureKind,
): void {
  if (mode === "auto") {
    deps.notify?.(machineryDeferMessage(kind), "warning");
  }
}

export function createReviewPipeline(deps: ReviewPipelineDeps): Authorizer["authorize"] {
  return async (details, query, log) => {
    const { config } = deps;
    // Session-scoped override (/ai-guard, ctrl+alt+g) wins over the config
    // default. Read per-call: the override object is mutable session state.
    const mode = deps.overrides.mode ?? config.mode;

    // surface-unmatched is expected config behavior (silent defer); no-target
    // is an unexpected ask (logged, then defer).
    const resolved = resolveReviewTarget(details, config);
    if ("reason" in resolved) {
      if (resolved.reason === "no-target") {
        log.debug(
          SHORT_CIRCUIT_EVENT,
          shortCircuit(details.requestId, resolved.surface, "no-target"),
        );
      }
      return { kind: "defer" };
    }
    const { surface, target } = resolved;

    const { requestId } = details;
    const base = { requestId, surface, target };
    const ask = buildAskContext(details, deps.cwd);
    const request: ReviewRequestContext = { ask, target };

    // Policy gate: defer when the deterministic engine already decided —
    // this link only adds value when the policy is undecided ("ask").
    const policyResult = query.checkPermission(surface, target, details.agentName ?? undefined);
    if (policyResult.state === "allow" || policyResult.state === "deny") {
      log.review(
        DECISION_EVENT,
        DecisionRecord.policyDecided(base, {
          state: policyResult.state,
          origin: policyResult.origin,
          matchedPattern: policyResult.matchedPattern ?? null,
        }),
      );
      return { kind: "defer" };
    }

    // Circuit breaker: a tripped breaker short-circuits without a model
    // call. Breaker trips are not recorded as model verdicts (no
    // recordVerdict) — only real model verdicts move the counters.
    if (deps.circuitBreaker.checkAndResetIfTripped(config.circuitBreaker)) {
      const verdict =
        config.circuitBreaker.verdict === "deny"
          ? {
              kind: "deny" as const,
              reason: BREAKER_DENY_REASON,
            }
          : { kind: "defer" as const };
      log.review(DECISION_EVENT, DecisionRecord.breaker(base, config.circuitBreaker.verdict));
      // A forced defer interrupts the human with no dialog context of its
      // own — surface why (the breaker verdict bypasses the mode mapping
      // by design: specific config beats the general mode).
      if (verdict.kind === "defer") {
        deps.notify?.(
          "ai-guard: circuit breaker tripped — too many reviewer denials, deferring to you",
          "warning",
        );
      }
      return verdict;
    }

    // 5. Resolve model + auth.
    const modelId = `${config.provider}/${config.model}`;
    const model = deps.registry.find(config.provider, config.model);
    if (!model) {
      log.review(DECISION_EVENT, DecisionRecord.modelUnresolved(base, modelId));
      notifyMachineryEscape(deps, mode, "model-unresolved");
      return { kind: "defer" };
    }

    // getApiKeyAndHeaders is wrapped to never throw — a thrown error and an
    // { ok: false } result both collapse to one auth-failed defer path.
    const auth = await resolveAuth(deps.registry, model);
    if (!auth.ok) {
      log.review(
        DECISION_EVENT,
        DecisionRecord.authFailed(base, modelId, normalizeAndRedactText(auth.error)),
      );
      notifyMachineryEscape(deps, mode, "auth-failed");
      return { kind: "defer" };
    }

    // 6. Strip transcript (feeds both the prompt and the cache fingerprint).
    let transcript;
    try {
      transcript = stripTranscript(deps.sessionManager, {
        maxUserMessages: config.transcript.maxUserMessages,
        maxToolCalls: config.transcript.maxToolCalls,
        maxCharsPerEntry: config.transcript.maxCharsPerEntry,
      });
    } catch (e) {
      log.debug(
        SHORT_CIRCUIT_EVENT,
        shortCircuit(requestId, surface, "transcript-error", {
          error: normalizeAndRedactText(e instanceof Error ? e.message : String(e)),
        }),
      );
      notifyMachineryEscape(deps, mode, "transcript-error");
      return { kind: "defer" };
    }

    // 7. Cache lookup. The request snapshot contains the action context,
    // working directory, and policy-derived path boundary, so a verdict
    // cannot cross those contexts.
    const commandHash = shortHash(reviewRequestCacheMaterial(request));
    const contextHash = shortHash(transcript.trustedIntent.join("\0"));
    const cc = config.cache;
    const lookup = deps.verdictCache.lookup(commandHash, contextHash, cc);
    if (lookup.hit) {
      // Cached verdicts are allow/deny only (defers are never stored), so
      // the defer branch of the mapping is unreachable here.
      const emitted = applyVerdictMode(mode, lookup.verdict);
      let record = DecisionRecord.cacheHit(base, lookup.verdict);
      if (emitted.kind !== lookup.verdict.kind) {
        record = mapped(record, mode, emitted.kind);
        // manual: the human now adjudicates a deny they'd otherwise never
        // see the reasoning for (the dialog renders only the request).
        if (emitted.kind === "defer") {
          deps.notify?.(manualEscalationMessage(lookup.verdict, lookup.riskLevel), "warning");
        }
      }
      log.review(DECISION_EVENT, record);
      return emitted;
    }
    // Cache miss: record the miss reason for telemetry.
    log.debug(CACHE_LOOKUP_EVENT, cacheLookup(requestId, surface, lookup.missReason));

    // Build prompt (redaction happens inside buildReviewPrompt).
    const systemPrompt = buildReviewSystemPrompt(config.instructions);
    const userPrompt = buildReviewPrompt(transcript, request);

    // Model review.
    const callCtx: ModelCallContext = {
      model,
      completeSimple: deps.completeSimple,
      auth: { apiKey: auth.apiKey, headers: auth.headers },
      reasoning: config.reasoning,
      log,
      requestId,
    };
    const reviewOutcome = await reviewModel(callCtx, systemPrompt, userPrompt, config.timeoutMs);

    if (reviewOutcome.rawReply !== undefined) {
      log.debug(MODEL_REPLY_EVENT, modelReply(requestId, modelId, reviewOutcome.rawReply));
    }

    // The mode maps only what the link EMITS: the breaker still
    // counts real model denials and the cache still stores the model's
    // deny, so a cached deny maps identically on a later hit. Defer isn't
    // cached (cache hits and breaker trips short-circuited above).
    const emitted = applyVerdictMode(mode, reviewOutcome.verdict, {
      kind: reviewOutcome.deferKind,
      reason: reviewOutcome.deferReason,
    });
    let record = DecisionRecord.model(base, modelId, transcript.strippedCount, reviewOutcome);
    if (emitted.kind !== reviewOutcome.verdict.kind) {
      record = mapped(record, mode, emitted.kind);
      if (emitted.kind === "defer") {
        deps.notify?.(
          manualEscalationMessage(reviewOutcome.verdict, reviewOutcome.riskLevel),
          "warning",
        );
      }
    }
    // In auto mode an emitted defer can only be a machinery failure
    // (timeout, call-failed, empty-reply, no-json, invalid-verdict-value)
    // that escaped the fail-closed mapping — the human is about to see an
    // interruption they didn't opt into, so explain it.
    if (mode === "auto" && emitted.kind === "defer") {
      deps.notify?.(machineryDeferMessage(reviewOutcome.deferKind), "warning");
    }
    log.review(DECISION_EVENT, record);

    deps.circuitBreaker.recordVerdict(reviewOutcome.verdict.kind);
    if (reviewOutcome.verdict.kind !== "defer") {
      deps.verdictCache.store(
        commandHash,
        contextHash,
        { verdict: reviewOutcome.verdict, riskLevel: reviewOutcome.riskLevel },
        cc,
      );
    }

    return emitted;
  };
}

/**
 * Resolve model auth, normalizing a thrown error into an { ok: false } result
 * so the caller has a single failure path.
 *
 * @param registry - The model registry to resolve auth from.
 * @param model - The model to resolve auth for.
 * @returns The resolved auth, or an `{ ok: false, error }` result on failure.
 */
async function resolveAuth(
  registry: ModelRegistryLike,
  model: Model<Api>,
): Promise<ResolvedRequestAuth> {
  try {
    return await registry.getApiKeyAndHeaders(model);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fast deterministic hash to shorten long strings for cache/identity keys.
 *
 * Copied from pi-ai's internal `utils/hash.ts` (not re-exported from the
 * package root). Two independent 32-bit Math.imul hashes (cypherCB),
 * finalized and combined as base36.
 *
 * @param str - The string to hash.
 * @returns A short base36 hash of the input string.
 */
function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
