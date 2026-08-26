/**
 * ReviewPipeline: the deep module behind the AI Guard chain link.
 *
 * The interface is `Authorizer["authorize"]` (the upstream seam);
 * `ReviewPipelineDeps` is a construction parameter, not the interface. Session
 * state is captured by closure at construction time.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Authorizer, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { buildAskContext, resolveReviewTarget } from "./ask-eligibility.ts";
import type { AiGuardConfig, Mode } from "./config-schema.ts";
import {
  BREAKER_DENY_REASON,
  CACHE_LOOKUP_EVENT,
  DECISION_EVENT,
  type DecisionRecordEntry,
  DecisionRecord,
  MODEL_REPLY_EVENT,
  SHORT_CIRCUIT_EVENT,
  cacheLookup,
  mapped,
  modelReply,
  shortCircuit,
} from "./decision-record.ts";
import { NOTIFY_PREFIX } from "./logger.ts";
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
import { normalizeAndRedactText, shortHash } from "./utils.ts";
import { applyVerdictMode, autoDenyReason, manualEscalationMessage } from "./verdict-mode.ts";
import type { RiskLevel } from "./verdict.ts";

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
 * The mode mapping's shared footwork for a gate that emitted a real
 * verdict (cache-hit and fresh model — the two paths that can be remapped):
 * when the mapping changes what the link EMITS, annotate the decision
 * record with the mapping facts, and when the change escalates to the
 * human (manual mode's deny→defer) carry the reviewer's reasoning via
 * notify — the permission dialog renders only the request.
 *
 * Only the mapping result belongs here. The call sites keep their own
 * verdict sources (cache entry vs model outcome) and their extra notify
 * paths (auto mode's machinery explanation lives only on the fresh path).
 *
 * @param record - The gate's decision record (cache-hit or model).
 * @param mode - The effective mode.
 * @param original - The verdict before mapping.
 * @param emitted - The verdict after mapping.
 * @param riskLevel - The original verdict's risk level.
 * @param deps - Pipeline deps (notify is optional).
 * @returns The annotated record, or `record` unchanged when nothing was mapped.
 */
function annotateAndEscalate(
  record: DecisionRecordEntry,
  mode: Mode,
  original: AuthorizerVerdict,
  emitted: AuthorizerVerdict,
  riskLevel: RiskLevel | undefined,
  deps: ReviewPipelineDeps,
): DecisionRecordEntry {
  if (emitted.kind === original.kind) {
    return record;
  }
  const annotated = mapped(record, mode, emitted.kind);
  if (emitted.kind === "defer") {
    deps.notify?.(manualEscalationMessage(original, riskLevel), "warning");
  }
  return annotated;
}

/**
 * Build the AI Guard authorizer from resolved session state. The returned
 * `authorize` function is the upstream `Authorizer["authorize"]` seam — the
 * only interface callers (extension.ts) and tests cross.
 *
 * @param deps - The resolved session-state dependencies for the pipeline.
 * @returns The `authorize` function implementing the review pipeline.
 */
export function createReviewPipeline(deps: ReviewPipelineDeps): Authorizer["authorize"] {
  return async (details, query, log) => {
    const { config } = deps;
    // Session-scoped override (/ai-guard, ctrl+alt+g) wins over the config
    // default. Read per-call: the override object is mutable session state.
    const mode = deps.overrides.mode ?? config.mode;

    // surface-unmatched is expected config behavior (silent defer; outside
    // this link's jurisdiction). no-target is an unexpected ask — the
    // REVIEW FAILED to open, so auto mode denies it like any other
    // machinery failure.
    const resolved = resolveReviewTarget(details, config);
    if ("reason" in resolved) {
      if (resolved.reason === "no-target") {
        log.debug(
          SHORT_CIRCUIT_EVENT,
          shortCircuit(details.requestId, resolved.surface, "no-target"),
        );
        if (mode === "auto") {
          deps.circuitBreaker.recordMachineryFailure();
          return { kind: "deny", reason: autoDenyReason("no-target") };
        }
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
      // Pass-through gate: the policy already decided and the link adds no
      // judgment — debug stream only (see the log-stream doctrine in
      // decision-record.ts).
      log.debug(
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
    if (deps.circuitBreaker.isTripped(config.circuitBreaker)) {
      // The trip consumes the recoverable tier — reset explicitly, so the
      // side effect is visible here rather than hidden in a query.
      deps.circuitBreaker.resetConsecutive();
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
          `${NOTIFY_PREFIX} circuit breaker tripped — too many reviewer denials, deferring to you`,
          "warning",
        );
      }
      return verdict;
    }

    // 5. Resolve model + auth.
    const modelId = `${config.provider}/${config.model}`;
    const model = deps.registry.find(config.provider, config.model);
    if (!model) {
      const record = DecisionRecord.modelUnresolved(base, modelId);
      if (mode === "auto") {
        // Auto denies EVERYTHING that would fall to the human — including
        // machinery failures; the classified failure becomes the reason.
        log.review(
          DECISION_EVENT,
          mapped(record, mode, "deny", autoDenyReason("model-unresolved")),
        );
        return { kind: "deny", reason: autoDenyReason("model-unresolved") };
      }
      log.review(DECISION_EVENT, record);
      return { kind: "defer" };
    }

    // getApiKeyAndHeaders is wrapped to never throw — a thrown error and an
    // { ok: false } result both collapse to one auth-failed defer path.
    const auth = await resolveAuth(deps.registry, model);
    if (!auth.ok) {
      const record = DecisionRecord.authFailed(base, modelId, normalizeAndRedactText(auth.error));
      if (mode === "auto") {
        deps.circuitBreaker.recordMachineryFailure();
        log.review(DECISION_EVENT, mapped(record, mode, "deny", autoDenyReason("auth-failed")));
        return { kind: "deny", reason: autoDenyReason("auth-failed") };
      }
      log.review(DECISION_EVENT, record);
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
      const record = DecisionRecord.transcriptError(base);
      if (mode === "auto") {
        deps.circuitBreaker.recordMachineryFailure();
        log.review(
          DECISION_EVENT,
          mapped(record, mode, "deny", autoDenyReason("transcript-error")),
        );
        return { kind: "deny", reason: autoDenyReason("transcript-error") };
      }
      log.review(DECISION_EVENT, record);
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
      const record = annotateAndEscalate(
        DecisionRecord.cacheHit(base, lookup.verdict),
        mode,
        lookup.verdict,
        emitted,
        lookup.riskLevel,
        deps,
      );
      // Replay gate: the verdict was already recorded at its model gate —
      // debug stream only (see the log-stream doctrine in
      // decision-record.ts).
      log.debug(DECISION_EVENT, record);
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

    // Raw replies are verbose AND unnecessary for clean verdicts (the
    // structured record + sentinel suffice) — only defer failures keep the
    // original text, so a broken parse can be replayed.
    if (reviewOutcome.verdict.kind === "defer" && reviewOutcome.rawReply !== undefined) {
      // The raw reply may re-quote prompt content — redact before it
      // lands in any log stream (models can parrot credentials).
      log.debug(
        MODEL_REPLY_EVENT,
        modelReply(requestId, modelId, normalizeAndRedactText(reviewOutcome.rawReply)),
      );
    }

    // The mode maps only what the link EMITS: the breaker still
    // counts real model denials and the cache still stores the model's
    // deny, so a cached deny maps identically on a later hit. Defer isn't
    // cached (cache hits and breaker trips short-circuited above).
    const emitted = applyVerdictMode(mode, reviewOutcome.verdict, {
      kind: reviewOutcome.deferKind,
      reason: reviewOutcome.deferReason,
    });
    // model-defer in manual/default passes through to the human — but the
    // upstream defer verdict carries no reason field, so the dialog alone
    // would never show WHAT the reviewer wants clarified. Mirror it via
    // the escalation channel (footer/notify), symmetric with auto's deny
    // reason.
    if (
      emitted.kind === "defer" &&
      reviewOutcome.deferKind === "model-defer" &&
      reviewOutcome.deferReason
    ) {
      deps.notify?.(
        `${NOTIFY_PREFIX} the reviewer asks for clarification: ${reviewOutcome.deferReason}`,
        "info",
      );
    }
    const record = annotateAndEscalate(
      DecisionRecord.model(base, modelId, transcript.strippedCount, reviewOutcome),
      mode,
      reviewOutcome.verdict,
      emitted,
      reviewOutcome.riskLevel,
      deps,
    );
    log.review(DECISION_EVENT, record);

    // Real model verdicts feed the breaker as usual; auto's
    // machinery-failure denies (the reviewer never produced a verdict)
    // also count via recordMachineryFailure — a broken reviewer can trip
    // the breaker, not just a miscalibrated one.
    deps.circuitBreaker.recordVerdict(reviewOutcome.verdict.kind);
    if (
      mode === "auto" &&
      reviewOutcome.verdict.kind === "defer" &&
      reviewOutcome.deferKind !== "model-defer"
    ) {
      deps.circuitBreaker.recordMachineryFailure();
    }
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
