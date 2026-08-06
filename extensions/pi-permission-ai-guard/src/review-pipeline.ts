/**
 * ReviewPipeline: the deep module behind the AI Guard chain link.
 *
 * Replaces the 7-getter `AskReviewerDeps` dependency bag. Session state is
 * captured by closure at construction time — no lazy getters, no test-only
 * micro-seams. The interface is `Authorizer["authorize"]` (the upstream
 * seam); `ReviewPipelineDeps` is a construction parameter, not the interface.
 *
 * The 10-step decision flow (eligibility → policy gate → circuit breaker →
 * model resolve → auth → transcript strip → cache lookup → prompt build →
 * model review → record) is the module's private implementation. Every
 * failure path defers.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { Authorizer } from "@gotgenes/pi-permission-system";

import { resolveReviewTarget } from "./ask-eligibility.ts";
import type { AiGuardConfig } from "./config-schema.ts";
import {
  BREAKER_DENY_REASON,
  CACHE_LOOKUP_EVENT,
  DECISION_EVENT,
  DecisionRecord,
  MODEL_REPLY_EVENT,
  SHORT_CIRCUIT_EVENT,
  cacheLookup,
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
import { buildReviewRequestContext, reviewRequestCacheMaterial } from "./review-request.ts";
import type { CircuitBreaker, VerdictCache } from "./session-state.ts";
import { type SessionManagerLike, stripTranscript } from "./transcript-stripper.ts";
import { normalizeAndRedactText } from "./utils.ts";

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
  /** Model call function (wrapped provider.streamSimple().result()). */
  completeSimple: CompleteSimpleFn;
}

/**
 * Build the AI Guard authorizer from resolved session state.
 *
 * The returned `authorize` function is the upstream `Authorizer["authorize"]`
 * seam — the only interface callers (extension.ts) and tests cross. The
 * 10-step pipeline is private to this closure.
 *
 * @param deps - The resolved session-state dependencies for the pipeline.
 * @returns The `authorize` function implementing the 10-step review pipeline.
 */
export function createReviewPipeline(deps: ReviewPipelineDeps): Authorizer["authorize"] {
  return async (details, query, log) => {
    const { config } = deps;

    // 1-2. Resolve the review target (surface match + target extraction).
    //    surface-unmatched is expected config behavior (silent defer);
    //    no-target is an unexpected ask (logged, then defer).
    const resolved = resolveReviewTarget(details, config);
    if ("reason" in resolved) {
      if (resolved.reason === "no-target") {
        const surface = details.accessIntent?.surface ?? details.surface ?? undefined;
        log.debug(SHORT_CIRCUIT_EVENT, shortCircuit(details.requestId, surface, "no-target"));
      }
      return { kind: "defer" };
    }
    const { surface, target } = resolved;

    const { requestId } = details;
    const base = { requestId, surface, target };
    const request = buildReviewRequestContext(details, surface, target, deps.cwd);

    // 3. Policy gate: defer when the deterministic engine already decided —
    //    this link only adds value when the policy is undecided ("ask").
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

    // 4. Circuit breaker: a tripped breaker short-circuits without a model
    //    call. Breaker trips are not recorded as model verdicts (no
    //    recordVerdict) — only real model verdicts move the counters.
    if (deps.circuitBreaker.checkAndResetIfTripped(config.circuitBreaker)) {
      const verdict =
        config.circuitBreaker.verdict === "deny"
          ? {
              kind: "deny" as const,
              reason: BREAKER_DENY_REASON,
            }
          : { kind: "defer" as const };
      log.review(DECISION_EVENT, DecisionRecord.breaker(base, config.circuitBreaker.verdict));
      return verdict;
    }

    // 5. Resolve model + auth.
    const modelId = `${config.provider}/${config.model}`;
    const model = deps.registry.find(config.provider, config.model);
    if (!model) {
      log.review(DECISION_EVENT, DecisionRecord.modelUnresolved(base, modelId));
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
      log.review(DECISION_EVENT, DecisionRecord.cacheHit(base, lookup.verdict));
      return lookup.verdict;
    }
    // Cache miss: record the miss reason for telemetry. Cache hits are
    // already covered by the cache-hit decision record above — no duplicate
    // debug event.
    log.debug(CACHE_LOOKUP_EVENT, cacheLookup(requestId, surface, lookup.missReason));

    // 8. Build prompt (redaction happens inside buildReviewPrompt).
    const systemPrompt = buildReviewSystemPrompt(config.instructions);
    const userPrompt = buildReviewPrompt(transcript, {
      surface: request.surface,
      target: request.target,
      actionText: request.actionText,
      cwd: request.cwd,
      canonicalBoundary: request.canonicalBoundary,
    });

    // 9. Model review.
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

    log.review(
      DECISION_EVENT,
      DecisionRecord.model(base, modelId, transcript.strippedCount, reviewOutcome),
    );

    // 10. Record the model verdict into the breaker counters and cache.
    //     Defer isn't cached (cache hits and breaker trips short-circuited above).
    deps.circuitBreaker.recordVerdict(reviewOutcome.verdict.kind);
    if (reviewOutcome.verdict.kind !== "defer") {
      deps.verdictCache.store(
        commandHash,
        contextHash,
        { verdict: reviewOutcome.verdict, riskLevel: reviewOutcome.riskLevel },
        cc,
      );
    }

    return reviewOutcome.verdict;
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
 * package root, so inlined here to avoid a private subpath import that could
 * break on upstream refactors). Two independent 32-bit Math.imul hashes
 * (cypherCB), finalized and combined as base36.
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
