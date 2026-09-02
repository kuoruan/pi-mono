/**
 * ReviewPipeline: the deep module behind the AI Guard chain link.
 *
 * The interface is `Authorizer["authorize"]` (the upstream seam);
 * `ReviewPipelineDeps` is a construction parameter, not the interface. Session
 * state is captured by closure at construction time.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Authorizer, AuthorizerLog, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { type DriftWarnState, openAsk } from "#src/ask/ask.ts";
import { buildReviewPrompt, buildReviewSystemPrompt } from "#src/ask/prompt.ts";
import { reviewRequestCacheMaterial, type ReviewRequestContext } from "#src/ask/review-request.ts";
import { type SessionManagerLike, stripTranscript } from "#src/ask/transcript-stripper.ts";
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
} from "#src/audit/decision-record.ts";
import type { AiGuardConfig, Mode } from "#src/config/config-schema.ts";
import {
  type CompleteSimpleFn,
  type ModelCallContext,
  type ModelRegistryLike,
  type ResolvedRequestAuth,
  reviewModel,
} from "#src/model/model-review.ts";
import type { ModelCallDeferKind, RiskLevel, VerdictLean } from "#src/model/model-verdict.ts";
import { effectiveOverride, type SessionOverrides } from "#src/session/session-overrides.ts";
import { normalizeAndRedactText, shortHash } from "#src/utils.ts";

import { accountModelOutcome, type CircuitBreaker, consumeTrip } from "./circuit-breaker.ts";
import { PRE_CALL_MACHINERY_KINDS, type PreCallMachineryKind } from "./machinery-kinds.ts";
import type { VerdictCache } from "./verdict-cache.ts";
import {
  applyVerdictMode,
  type DenyInstructionSource,
  machineryDenyReason,
  machineryDeferNotice,
  machineryTarget,
  resolveMapping,
  withAgentInstruction,
} from "./verdict-mode.ts";

/**
 * Fire-and-forget user notification — the host UI context's own notify
 * signature (the extension wraps ctx.ui.notify; absent in headless tests
 * and when no UI context was captured).
 */
export type NotifyFn = ExtensionUIContext["notify"];

/**
 * One model-gate deny recorded for the session's denied panel — what the
 * reviewer itself judged dangerous (mapping artifacts and machinery
 * denials are not recorded; the panel answers "what did the reviewer
 * refuse").
 */
export interface DenyRecord {
  /** The ask's request id. */
  requestId: string;
  /** The tool surface. */
  surface: string;
  /** The reviewed value. */
  target: string;
  /** The model's deny reason (the teaching reason, un-instructed). */
  reason: string | undefined;
  /** The model-assessed risk level, when the model supplied one. */
  riskLevel: string | undefined;
  /** ISO timestamp of the decision. */
  timestamp: string;
}

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
  /** Session model-gate deny log (the /ai-guard denied panel's data). */
  denyHistory: DenyRecord[];
  /**
   * Human notification for verdicts that escalate to the user — REQUIRED:
   * production always wires the lifecycle's notify bridge (the plain
   * notify channel, try/catch around the disposed-runner window); every
   * escalate path depends on it, so absence is never a legal pipeline
   * shape.
   */
  notify: NotifyFn;
}

/**
 * What the escalation footwork hands back to a verdict gate: the
 * annotated record to write, and the agent instruction's source for the
 * deny the gate may be about to return (null when nothing deny-shaped
 * was emitted).
 */
interface EscalationFootwork {
  /** The annotated (or plain) decision record. */
  record: DecisionRecordEntry;
  /** The instruction source for an emitted deny, else null. */
  instructionSource: DenyInstructionSource | null;
}

/**
 * Release a pre-call machinery gate: the single disposal seam for the
 * four reviewer-failure gates that never hold a parsed verdict (no-target,
 * model-unresolved, transcript-error, auth-failed).
 *
 * Owns the whole disposition: the machinery lane lookup, the deny reason
 * (computed ONCE — the audit annotation and the returned verdict share
 * it), the breaker's recoverable-tier credit, the review-stream record
 * (mapped when the gate denies, plain when it defers), the forced-defer
 * notice, and the returned verdict. The shared invariants — a broken
 * reviewer never rubber-stamps, every reviewer-relevant gate writes the
 * review stream — live here instead of being hand-copied per gate.
 *
 * @param mode - The effective mode (the machinery lane's only input).
 * @param kind - The classified machinery failure (pre-call: the review
 *   never opened).
 * @param record - The gate's decision record (verdict "defer" — the
 *   review never opened).
 * @param breaker - The session circuit breaker (recoverable-tier credit).
 * @param log - The authorizer log pair (review stream).
 * @param notify - The pipeline's notify (the forced-defer notice).
 * @returns The verdict the gate emits.
 */
function releaseMachineryGate(
  mode: Mode,
  kind: PreCallMachineryKind,
  record: DecisionRecordEntry,
  breaker: CircuitBreaker,
  log: AuthorizerLog,
  notify: NotifyFn,
): AuthorizerVerdict {
  if (machineryTarget(mode) !== "deny") {
    log.review(DECISION_EVENT, record);
    // Forced defer interrupts the human with no dialog context of its
    // own — same doctrine as the breaker trip: name the cause.
    notify(machineryDeferNotice(kind), "warning");
    return { kind: "defer" };
  }
  breaker.recordDenyEquivalent();
  const reason = machineryDenyReason(kind, mode);
  log.review(DECISION_EVENT, mapped(record, mode, "deny", reason));
  // The audit annotation keeps the un-instructed reason; the returned
  // verdict carries the agent instruction (a machinery denial was never
  // judged — retrying later is legitimate).
  return { kind: "deny", reason: withAgentInstruction(reason, "machinery") };
}

/**
 * Build the AI Guard authorizer from resolved session state. The returned
 * `authorize` function is the upstream `Authorizer["authorize"]` seam — the
 * only interface callers (extension.ts) and tests cross.
 *
 * @param deps - The resolved session dependencies for the pipeline.
 * @returns The `authorize` function implementing the review pipeline.
 */
export function createReviewPipeline(deps: ReviewPipelineDeps): Authorizer["authorize"] {
  // Once per pipeline instance: the fail-open notice (mode auto-approves
  // what the reviewer didn't) fires on the first mapped allow, then stays
  // silent — the operator asked for this mode, the notice guards against
  // forgetting it's on.
  const noticeState = { shown: false };

  const driftState: DriftWarnState = { warned: false };

  return async (details, query, log) => {
    const { config } = deps;
    // Session-scoped override (/ai-guard, ctrl+alt+g) wins over the config
    // default — the typed per-field accessor spells the rule once (see
    // effectiveOverride in session-overrides). Read per-call: the override
    // object is mutable session state.
    const mode = effectiveOverride(deps.overrides, config, "mode");

    // Per-call closure: the mode read here flows into every mapping
    // annotation below; noticeState/deps stay captured from the factory.
    // The mode mapping's shared footwork for the two gates that emit a real
    // verdict (cache-hit and fresh model): resolveMapping owns the deciding
    // rule (annotation input + every notify owed + the instruction
    // source); this closure performs the side effects — flip the notice
    // state, send the notify, annotate the record. The per-call constants
    // (mode, noticeState, deps) are closure-captured — only the
    // per-verdict facts travel as parameters.
    const annotateAndEscalate = (
      record: DecisionRecordEntry,
      original: AuthorizerVerdict,
      emitted: AuthorizerVerdict,
      riskLevel: RiskLevel | undefined,
      deferLean: VerdictLean | undefined,
      deferKind: ModelCallDeferKind | undefined,
      deferReason: string | undefined,
    ): EscalationFootwork => {
      const decision = resolveMapping({
        original,
        emitted,
        riskLevel,
        deferKind,
        deferReason,
        deferLean,
        mode,
        noticeShown: noticeState.shown,
      });
      if (decision.markNoticeShown) noticeState.shown = true;
      if (decision.notice) deps.notify(decision.notice.message, decision.notice.level);
      return {
        record: decision.annotate
          ? mapped(record, mode, emitted.kind, decision.emittedReason)
          : record,
        instructionSource: decision.instructionSource,
      };
    };

    // surface-unmatched is expected config behavior (silent defer; outside
    // this link's jurisdiction). no-target is an unexpected ask — the
    // REVIEW FAILED to open, so it follows the machinery lane.
    const opened = openAsk(details, config, deps.cwd, driftState);
    if ("reason" in opened) {
      if (opened.reason === PRE_CALL_MACHINERY_KINDS.noTarget) {
        log.debug(
          SHORT_CIRCUIT_EVENT,
          shortCircuit(details.requestId, opened.surface, PRE_CALL_MACHINERY_KINDS.noTarget),
        );
        // The review failed to open — a machinery-lane gate (a permanent
        // property of the ask's shape, not a transient reviewer failure).
        return releaseMachineryGate(
          mode,
          PRE_CALL_MACHINERY_KINDS.noTarget,
          DecisionRecord.noTarget(details.requestId, opened.surface),
          deps.circuitBreaker,
          log,
          deps.notify,
        );
      }
      return { kind: "defer" };
    }
    const { surface, target, ask } = opened;

    const { requestId } = details;
    // The record's target carries the raw command — sanitize it like every
    // other untrusted field (prompt, rawReply, defer reason): a credential
    // inside the command must not land unredacted in the always-on review
    // log (normalizeAndRedactText: zero-width/control strip + secret
    // redaction; see the twin call on the prompt side).
    const base = {
      requestId,
      surface,
      target: normalizeAndRedactText(target),
    };
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
    // call. The trip's consume (query + recoverable reset) is one visible
    // accounting step beside the breaker (see consumeTrip in
    // circuit-breaker) — breaker trips are not recorded as model verdicts.
    const trip = consumeTrip(deps.circuitBreaker, config.circuitBreaker);
    if (trip.tripped) {
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
        deps.notify(
          `circuit breaker tripped — too many reviewer denials, deferring to you`,
          "warning",
        );
      }
      // The total tier is a persistent session-level state the operator
      // otherwise only discovers from mysteriously denied commands — name
      // the state change once (the breaker re-arms the notice after a
      // manual reset). Consecutive-tier trips stay quiet: they self-heal
      // on the next allow, and their per-ask machinery notices already
      // speak on the defer lanes.
      if (trip.totalNoticeDue) {
        // Error-grade: the guard's review function is DOWN for the session
        // (every ask short-circuits), and recovery needs the operator's
        // hand — the first ambient occupant of the error rung. Under
        // notifyLevel gating this is deliberate: `warning` silences
        // per-request noise but a total trip stays visible at `error`.
        deps.notify(
          `circuit breaker tripped — total tier reached, blocking all reviews until /ai-guard breaker reset or restart`,
          "error",
        );
      }
      // A breaker deny is a machinery denial (the reviewer is untrusted,
      // the request was never judged) — the returned reason carries the
      // machinery instruction; the audit record above keeps the bare
      // BREAKER_DENY_REASON.
      if (verdict.kind === "deny") {
        return {
          kind: "deny",
          reason: withAgentInstruction(verdict.reason, "machinery"),
        };
      }
      return verdict;
    }

    // 5. Resolve the model. Fails fast on a config error, and sits BEFORE
    // the cache (an unresolved model makes every ask a machinery failure;
    // the cache lookup adds nothing). registry.find is the one unwrapped
    // dependency call in the pipeline — a throwing registry collapses into
    // model-unresolved like an absent one.
    const modelId = `${config.provider}/${config.model}`;
    let model;
    try {
      model = deps.registry.find(config.provider, config.model);
    } catch {
      model = undefined;
    }
    if (!model) {
      // An unresolved model makes every ask a machinery failure — strict
      // and permissive deny what would fall to the human, the others defer.
      const record = DecisionRecord.modelUnresolved(base, modelId);
      return releaseMachineryGate(
        mode,
        PRE_CALL_MACHINERY_KINDS.modelUnresolved,
        record,
        deps.circuitBreaker,
        log,
        deps.notify,
      );
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
        shortCircuit(requestId, surface, PRE_CALL_MACHINERY_KINDS.transcriptError, {
          error: normalizeAndRedactText(e instanceof Error ? e.message : String(e)),
        }),
      );
      const record = DecisionRecord.transcriptError(base);
      return releaseMachineryGate(
        mode,
        PRE_CALL_MACHINERY_KINDS.transcriptError,
        record,
        deps.circuitBreaker,
        log,
        deps.notify,
      );
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
      // the defer branch of the mapping is unreachable here — the
      // instruction source derives "content" structurally (no defer
      // classification exists to make it machinery). The cached riskLevel
      // rides along so a cached deny maps identically to its fresh first
      // pass.
      const emitted = applyVerdictMode(mode, lookup.verdict, undefined, lookup.riskLevel);
      const { record, instructionSource } = annotateAndEscalate(
        DecisionRecord.cacheHit(base, lookup.verdict),
        lookup.verdict,
        emitted,
        lookup.riskLevel,
        // Cached verdicts are allow/deny only — no defer, so no lean and
        // no defer classification.
        undefined,
        undefined,
        undefined,
      );
      // Replay gate: the verdict was already recorded at its model gate —
      // debug stream only (see the log-stream doctrine in
      // decision-record.ts).
      log.debug(DECISION_EVENT, record);
      // A cached deny replays the model's own reason — the instruction
      // is appended exactly once per hit (the cache holds the
      // un-instructed original; each hit re-appends).
      if (emitted.kind === "deny") {
        return {
          kind: "deny",
          reason: withAgentInstruction(emitted.reason, instructionSource ?? "content"),
        };
      }
      return emitted;
    }
    // Cache miss: record the miss reason for telemetry.
    log.debug(CACHE_LOOKUP_EVENT, cacheLookup(requestId, surface, lookup.missReason));

    // 8. Resolve auth — AFTER the cache: a hit never needed auth, and a
    // repeat ask survives an auth flap via its cached verdict.
    // getApiKeyAndHeaders is wrapped to never throw — a thrown error and an
    // { ok: false } result both collapse to one auth-failed defer path.
    const auth = await resolveAuth(deps.registry, model);
    if (!auth.ok) {
      const record = DecisionRecord.authFailed(base, modelId, normalizeAndRedactText(auth.error));
      return releaseMachineryGate(
        mode,
        PRE_CALL_MACHINERY_KINDS.authFailed,
        record,
        deps.circuitBreaker,
        log,
        deps.notify,
      );
    }

    // Build prompt (redaction happens inside buildReviewPrompt).
    const systemPrompt = buildReviewSystemPrompt(config.instructions);
    const userPrompt = buildReviewPrompt(transcript, request);

    // Model review.
    const callCtx: ModelCallContext = {
      model,
      completeSimple: deps.completeSimple,
      auth: { apiKey: auth.apiKey, headers: auth.headers },
      reasoning: config.reasoning,
      maxTokens: config.maxTokens,
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
    const emitted = applyVerdictMode(
      mode,
      reviewOutcome.verdict,
      {
        kind: reviewOutcome.deferKind,
        reason: reviewOutcome.deferReason,
        lean: reviewOutcome.lean,
      },
      reviewOutcome.riskLevel,
    );
    const { record, instructionSource } = annotateAndEscalate(
      DecisionRecord.model(base, modelId, transcript.strippedCount, reviewOutcome, contextHash),
      reviewOutcome.verdict,
      emitted,
      reviewOutcome.riskLevel,
      reviewOutcome.lean,
      reviewOutcome.deferKind,
      reviewOutcome.deferReason,
    );
    log.review(DECISION_EVENT, record);

    // The denied panel's data: record what the MODEL denied (the review's
    // own judgment — mapping artifacts and machinery denials are absent by
    // design; the panel answers "what did the reviewer refuse"). The
    // teaching reason, un-instructed, exactly as the audit record holds it;
    // the target rides through the record's redacted form (a credential in
    // the command must not echo to the terminal via the panel's notify).
    if (reviewOutcome.verdict.kind === "deny") {
      deps.denyHistory.push({
        requestId,
        surface,
        target: base.target,
        reason: reviewOutcome.verdict.reason,
        riskLevel: reviewOutcome.riskLevel ?? undefined,
        timestamp: new Date().toISOString(),
      });
    }

    // The per-ask accounting: the model's real verdict feeds the breaker,
    // and a machinery denial (the reviewer never produced a verdict) earns
    // a recoverable-tier credit — the doctrine lives beside the breaker
    // (see accountModelOutcome in circuit-breaker).
    accountModelOutcome(deps.circuitBreaker, reviewOutcome.verdict.kind, emitted);
    if (reviewOutcome.verdict.kind !== "defer") {
      deps.verdictCache.store(
        commandHash,
        contextHash,
        { verdict: reviewOutcome.verdict, riskLevel: reviewOutcome.riskLevel },
        cc,
      );
    }

    // The returned deny carries the agent instruction; the audit record
    // (annotated above) and the cache (stored above) keep the un-instructed
    // reason. The source discrimination (machinery iff the review failed,
    // content iff the request was judged) lives in resolveMapping — same
    // rule as the cache-hit gate above.
    if (emitted.kind === "deny") {
      return {
        kind: "deny",
        reason: withAgentInstruction(emitted.reason, instructionSource ?? "content"),
      };
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
