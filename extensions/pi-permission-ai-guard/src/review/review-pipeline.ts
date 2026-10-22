/**
 * ReviewPipeline: the deep module behind the AI Guard chain link.
 *
 * The interface is `Authorizer["authorize"]` (the upstream seam);
 * `ReviewPipelineDeps` is a construction parameter, not the interface. Session
 * state is captured by closure at construction time.
 */

import type { Authorizer, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import {
  BREAKER_DENY_REASON,
  DecisionRecord,
  cacheLookup,
  coverage,
  modelReply,
  sanitizeRawReply,
  shortCircuit,
  type DecisionRecordEntry,
} from "#src/audit/decision-record.ts";
import {
  CACHE_LOOKUP_EVENT,
  COVERAGE_EVENT,
  DECISION_EVENT,
  DECISION_GATES,
  MODEL_REPLY_EVENT,
  SHORT_CIRCUIT_EVENT,
} from "#src/audit/events.ts";
import type { AiGuardConfig } from "#src/config/config-schema.ts";
import { resolveModePolicy } from "#src/config/mode-policy.ts";
import { effectiveOverride, type SessionOverrides } from "#src/config/session-overrides.ts";
import { PRE_CALL_MACHINERY_KINDS } from "#src/model/machinery-kinds.ts";
import type { RiskLevel } from "#src/model/model-verdict.ts";
import type { NotifyFn } from "#src/notice.ts";
import { openAsk } from "#src/review/request/ask.ts";
import {
  cacheIdentity,
  snapshotRequest,
  type ReviewRequestContext,
} from "#src/review/request/review-request.ts";
import {
  type SessionManagerLike,
  stripTranscript,
} from "#src/review/request/transcript-stripper.ts";
import { screenCommand } from "#src/review/screen/screen.ts";
import { bestEffort, errorMessage, normalizeAndRedactText } from "#src/utils.ts";

import { accountModelOutcome, type CircuitBreaker, consumeTrip } from "./circuit-breaker.ts";
import { floorVerdict } from "./deterministic-floor.ts";
import type { FloorHit } from "./deterministic-floor.ts";
import { createDisposition } from "./disposition.ts";
import type { CommandFacts } from "./request/command-facts.ts";
import { isMachineryFailure, type ReviewerEngine } from "./reviewer-engine.ts";
import type { VerdictCache } from "./verdict-cache.ts";
import { withAgentInstruction } from "./verdict-copy.ts";
import { applyVerdictMode, type ModelDeferInfo } from "./verdict-rule.ts";

/**
 * How many denials the session keeps for its denied panel. The panel shows the
 * newest handful; the cap bounds memory in a long session.
 */
const DENY_HISTORY_MAX = 50;

/**
 * One deny recorded for the session's denied panel — a screen hit or a
 * reviewer deny (mode mappings and machinery denials are not recorded; the
 * panel answers "what refused this request").
 */
export interface DenyRecord {
  /** The ask's request id. */
  requestId: string;
  /** The tool surface. */
  surface: string;
  /** The reviewed value. */
  target: string;
  /** The deny reason, un-instructed (the screen's or the reviewer's). */
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
  /** The reviewer backend (chat or classifier) — the only seam the pipeline reviews through. */
  engine: ReviewerEngine;
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
  /** Session deny log (the /ai-guard denied panel's data). */
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
 * Raise a reviewer allow to an ask when the command facts prove an
 * irreversible effect. Fires only on the reviewer's own allow — a defer the
 * mode maps to allow is the mode's explicit leniency, not a reviewer
 * judgment, and stays untouched.
 *
 * Runs on both emission paths (fresh and cache hit) because the cache stores
 * the reviewer's verdict, not the link's. The identity the record claims is
 * the review it actually ran (model, or the replayed hit — never a new model
 * judgment); `floorFacts` says what fired, and the emitted ask carries the
 * floor's own reason — never the mapping's "reviewer denied" line, which
 * would misreport an allow as a denial.
 *
 * @param verdict - The reviewer's verdict (pre-mapping on the fresh path, the stored one on a hit).
 * @param record - The gate's decision record.
 * @param facts - The command facts, or null for a non-bash surface.
 * @returns The verdict to map and the record to emit.
 */
function applyFloorToEmission(
  verdict: AuthorizerVerdict,
  record: DecisionRecordEntry,
  facts: CommandFacts | null,
): { verdict: AuthorizerVerdict; record: DecisionRecordEntry; floor: FloorHit | null } {
  const floored = floorVerdict(verdict, facts);
  if (floored.hit === null) return { verdict, record, floor: null };
  return {
    verdict: floored.verdict,
    record: { ...record, floorFacts: floored.hit.facts },
    floor: floored.hit,
  };
}

export function createReviewPipeline(deps: ReviewPipelineDeps): Authorizer["authorize"] {
  // The release seam, one per pipeline instance: it holds the
  // once-per-pipeline fail-open notice state privately.
  const disposition = createDisposition({
    notify: deps.notify,
    notifyApprovals: deps.config.notifyApprovals,
  });

  const authorize: Authorizer["authorize"] = async (details, query, log) => {
    const { config } = deps;
    // The single writer for decision records: the release seam returns the
    // record, this closure emits it. Machinery + model gates name a
    // reviewer-relevant judgment and ride the review stream; replays and
    // pass-throughs ride debug (see the log-stream doctrine in
    // decision-record.ts) — `record.gate` carries the choice, so no caller
    // re-derives it.
    const emitRecord = (record: DecisionRecordEntry): void => {
      if (record.gate === DECISION_GATES.cacheHit || record.gate === DECISION_GATES.policyDecided) {
        log.debug(DECISION_EVENT, record);
      } else {
        log.review(DECISION_EVENT, record);
      }
    };
    // Session-scoped override (/ai-guard, ctrl+alt+g) wins over the config
    // default — the typed per-field accessor spells the rule once (see
    // effectiveOverride in session-overrides). Read per-call: the override
    // object is mutable session state.
    const mode = effectiveOverride(deps.overrides, config, "mode");
    const { policy } = resolveModePolicy({ mode, customMode: config.customMode });

    // surface-unmatched is expected config behavior (silent defer; outside
    // this link's jurisdiction). no-target is an unexpected ask — the
    // REVIEW FAILED to open, so it follows the machinery lane.
    const opened = openAsk(details, config, deps.cwd);
    if ("reason" in opened) {
      if (opened.reason === PRE_CALL_MACHINERY_KINDS.noTarget) {
        log.debug(
          SHORT_CIRCUIT_EVENT,
          shortCircuit(details.requestId, opened.surface, PRE_CALL_MACHINERY_KINDS.noTarget),
        );
        // The review failed to open — a machinery-lane gate (a permanent
        // property of the ask's shape, not a transient reviewer failure).
        const released = disposition.releaseMachineryGate({
          policy,
          kind: PRE_CALL_MACHINERY_KINDS.noTarget,
          record: DecisionRecord.noTarget(details.requestId, opened.surface),
          breaker: deps.circuitBreaker,
        });
        emitRecord(released.record);
        return released.verdict;
      }
      // surface-unmatched is outside this link's jurisdiction, but staying
      // fully silent hides coverage gaps (misspelled surface, host-renamed
      // surface): one debug-stream record (gated on debugLog, like every
      // other short-circuit breadcrumb) so a "thought-covered but never
      // reviewed" misconfig is discoverable when diagnostics are on.
      // Deliberately the coverage event, not a shortCircuit() record:
      // surface-unmatched is NOT a machinery failure (it must never enter
      // the machinery taxonomy / lanes), only a coverage breadcrumb.
      log.debug(COVERAGE_EVENT, coverage(details.requestId, "surface-unmatched"));
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
    // The denied panel's data: what refused the request (a screen hit or a
    // model deny; mode mappings and machinery denials are absent by
    // design). The reason is the un-instructed teaching text, and the target
    // rides through the record's redacted form — a credential in the command
    // must not echo to the terminal via the panel's notify.
    const recordDenial = (reason: string, riskLevel: RiskLevel | undefined): void => {
      // The panel reads the newest handful; a long session must not grow the
      // array without bound.
      if (deps.denyHistory.length >= DENY_HISTORY_MAX) deps.denyHistory.shift();
      deps.denyHistory.push({
        requestId,
        surface,
        target: base.target,
        reason,
        riskLevel: riskLevel ?? undefined,
        timestamp: new Date().toISOString(),
      });
    };
    // No request context is built before the gates: the policy gate and
    // the breaker below decide without model evidence, and the
    // observed-facts snapshot (a project file read) is taken only on the
    // path that actually needs a model review — after the gates, before
    // the cache lookup.

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
          // `?? null` guards PPS 40's optional result field: `matchedSpelling`
          // is absent whenever the typed text decided, and an absent fact must
          // key the same as "typed text decided".
          matchedSpelling: policyResult.matchedSpelling ?? null,
        }),
      );
      return { kind: "defer" };
    }

    // Screen: the closed deterministic hard rules, the only layer that may
    // deny outright. It runs before the breaker and the model, so a hit costs
    // no model call, is never cached, and holds even with a tripped breaker.
    const screen = ask.fullCommand === undefined ? undefined : screenCommand(ask.fullCommand);
    if (screen?.kind === "deny") {
      const verdict = { kind: "deny" as const, reason: screen.reason };
      const released = disposition.releaseVerdictGate({
        policy,
        record: DecisionRecord.screenDecided(base, screen),
        original: verdict,
        emitted: applyVerdictMode(policy, verdict, undefined, "screen"),
        riskLevel: "critical",
        defer: undefined,
        cost: { kind: "fresh", latencyMs: 0 },
      });
      emitRecord(released.record);
      recordDenial(screen.reason, "critical");
      deps.circuitBreaker.recordVerdict("deny");
      return released.verdict;
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
        deps.notify(`breaker tripped after repeated denials; you decide`, "warning");
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
          `breaker tripped (total tier reached); reviews blocked until /ai-guard breaker reset or restart`,
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

    // Model resolution lives behind the engine seam. An unresolvable engine is
    // a construction-time throw in extension.ts, not a per-ask machinery
    // failure.

    // Strip transcript (feeds both the prompt and the cache fingerprint).
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
          error: normalizeAndRedactText(errorMessage(e)),
        }),
      );
      const released = disposition.releaseMachineryGate({
        policy,
        kind: PRE_CALL_MACHINERY_KINDS.transcriptError,
        record: DecisionRecord.transcriptError(base),
        breaker: deps.circuitBreaker,
      });
      emitRecord(released.record);
      return released.verdict;
    }

    // Cache lookup. The request snapshot contains the action context,
    // working directory, and policy-derived path boundary, so a verdict
    // cannot cross those contexts; the identity doctrine lives with the
    // builder (see cacheIdentity). The observed-facts snapshot is taken
    // here — after the policy and breaker gates, before the cache lookup —
    // so a decided ask never reads the project file, and every consumer
    // below (cache key, state, both lanes) reads one frozen value.
    const snapshot = snapshotRequest(ask);
    const request: ReviewRequestContext = {
      ask,
      target,
      observedFacts: snapshot.observedFacts,
      commandFacts: snapshot.commandFacts,
    };
    const { commandHash, contextHash } = cacheIdentity(request, transcript);
    const cc = config.cache;
    const lookup = deps.verdictCache.lookup(commandHash, contextHash, cc);
    if (lookup.hit) {
      // Cached verdicts are allow/deny only (defers are never stored). The
      // cached riskLevel rides along so a cached deny maps identically to
      // its fresh first pass. The deterministic floor may still synthesize a
      // defer from a cached allow — the only defer that can appear here, and
      // the release names it as the floor's own.
      const floored = applyFloorToEmission(
        lookup.verdict,
        DecisionRecord.cacheHit(base, lookup.verdict),
        request.commandFacts ?? null,
      );
      const released = disposition.releaseVerdictGate({
        policy,
        record: floored.record,
        original: floored.verdict,
        // One mapping only: the link emits what the (possibly floored)
        // verdict maps to, and the release ignores the emission whenever the
        // floor fired.
        emitted: floored.floor ? floored.verdict : applyVerdictMode(policy, lookup.verdict),
        riskLevel: lookup.riskLevel,
        // Cached verdicts are allow/deny only — no defer context at all.
        defer: undefined,
        // A hit replays a verdict, it measures nothing — the tail says so.
        cost: { kind: "cached" },
        floor: floored.floor,
      });
      const { record, verdict } = released;
      // Replay gate: the verdict was already recorded at its model gate —
      // emitRecord routes it to the debug stream by record.gate.
      emitRecord(record);
      // The release carries the returned verdict (a deny already has the
      // instruction appended exactly once per hit — the cache holds the
      // un-instructed original; each hit re-appends).
      return verdict;
    }
    // Cache miss: record the miss reason for telemetry.
    log.debug(CACHE_LOOKUP_EVENT, cacheLookup(requestId, surface, lookup.missReason));

    // Engine review. Model resolution, auth, prompt building, and the
    // call all live behind the engine seam — the pipeline only sees the
    // outcome (or a tagged pre-call machinery failure for the machinery
    // lane). Sits AFTER the cache: a hit never needed a call, and auth
    // stays inside the engine (a hit never needed auth).
    const engineResult = await deps.engine.review({
      transcript,
      request,
      log,
      requestId,
    });
    if (isMachineryFailure(engineResult)) {
      // Total by construction: `EngineMachineryKind` admits only the two
      // engine kinds, and only model-unresolved owns a record of its own.
      const isModelUnresolved = engineResult.kind === PRE_CALL_MACHINERY_KINDS.modelUnresolved;
      const record = isModelUnresolved
        ? DecisionRecord.modelUnresolved(base, engineResult.modelId)
        : DecisionRecord.authFailed(
            base,
            engineResult.modelId,
            normalizeAndRedactText(engineResult.detail ?? ""),
          );
      const released = disposition.releaseMachineryGate({
        policy,
        kind: isModelUnresolved
          ? PRE_CALL_MACHINERY_KINDS.modelUnresolved
          : PRE_CALL_MACHINERY_KINDS.authFailed,
        record,
        breaker: deps.circuitBreaker,
      });
      emitRecord(released.record);
      return released.verdict;
    }
    const { modelId } = engineResult;
    // A model never hard-denies; see denyTier in verdict-rule.ts.
    const reviewOutcome = engineResult.outcome;

    // Raw replies are verbose AND unnecessary for clean verdicts (the
    // structured record + sentinel suffice) — only defer failures keep the
    // original text, so a broken parse can be replayed. The raw reply may
    // re-quote prompt content — sanitize ONCE here (the single point: redact,
    // then bound the length) and feed both the debug event and the decision
    // record (models can parrot credentials).
    const deferReplySanitized =
      reviewOutcome.verdict.kind === "defer" && reviewOutcome.rawReply !== undefined
        ? sanitizeRawReply(reviewOutcome.rawReply)
        : undefined;
    if (deferReplySanitized !== undefined) {
      log.debug(MODEL_REPLY_EVENT, modelReply(requestId, modelId, deferReplySanitized));
    }

    // The fresh defer context, built once: applyVerdictMode routes it and
    // the mapping below reuses the same facts (one object, not three
    // re-spread scalars).
    const deferInfo: ModelDeferInfo | undefined =
      reviewOutcome.verdict.kind === "defer"
        ? {
            kind: reviewOutcome.deferKind,
            reason: reviewOutcome.deferReason,
            lean: reviewOutcome.lean,
          }
        : undefined;

    // The mode maps only what the link EMITS: the breaker still
    // counts real model denials and the cache still stores the model's
    // deny, so a cached deny maps identically on a later hit. Defer isn't
    // cached (cache hits and breaker trips short-circuited above).
    const emitted = applyVerdictMode(policy, reviewOutcome.verdict, deferInfo);
    // The deterministic floor: a reviewer allow cannot lift a fact that
    // proves the action unrecoverable (a history rewrite, a recursive delete
    // outside the project, a persistence install, an all-interfaces listener,
    // credential-shaped data handed to a sender, a raw device copy). The
    // record names the facts so the extra confirmation is auditable.
    const floored = applyFloorToEmission(
      reviewOutcome.verdict,
      DecisionRecord.model({
        base,
        modelId,
        strippedCount: transcript.strippedCount,
        reviewOutcome,
        contextHash,
        deferReplySanitized,
        anchorText: transcript.trustedIntent.at(-1),
      }),
      request.commandFacts ?? null,
    );
    const released = disposition.releaseVerdictGate({
      policy,
      record: floored.record,
      original: floored.verdict,
      // The one mapping from above, unless the floor replaced the verdict —
      // the release ignores the emission whenever the floor fired.
      emitted: floored.floor ? floored.verdict : emitted,
      riskLevel: reviewOutcome.riskLevel,
      defer: reviewOutcome.verdict.kind === "defer" ? deferInfo : undefined,
      floor: floored.floor,
      // latencyMs already covers the review's total cost: the empty-reply
      // retry accumulates into it and the pool stamps the whole walk (failover
      // included), so the tail is the ask's wall-clock review cost.
      cost: { kind: "fresh", latencyMs: reviewOutcome.latencyMs },
    });
    const { record, verdict } = released;
    emitRecord(record);

    // The denied panel's data: record what the MODEL denied (the review's
    // own judgment — mapping artifacts and machinery denials are absent by
    // design; the panel answers "what did the reviewer refuse"). The
    // teaching reason, un-instructed, exactly as the audit record holds it;
    // the target rides through the record's redacted form (a credential in
    // the command must not echo to the terminal via the panel's notify).
    if (reviewOutcome.verdict.kind === "deny") {
      recordDenial(reviewOutcome.verdict.reason ?? "", reviewOutcome.riskLevel);
    }

    // The per-ask accounting: the model's real verdict feeds the breaker,
    // and a machinery denial (the reviewer never produced a verdict) earns
    // a recoverable-tier credit — the doctrine lives beside the breaker
    // (see accountModelOutcome in circuit-breaker).
    accountModelOutcome(
      deps.circuitBreaker,
      reviewOutcome.verdict.kind,
      emitted,
      reviewOutcome.deferKind,
    );
    if (reviewOutcome.verdict.kind !== "defer" && engineResult.cacheable !== false) {
      deps.verdictCache.store(
        commandHash,
        contextHash,
        { verdict: reviewOutcome.verdict, riskLevel: reviewOutcome.riskLevel },
        cc,
      );
    }

    // The release carries the returned verdict: the audit record (annotated
    // above) and the cache (stored above) keep the un-instructed reason;
    // the returned deny carries the agent instruction. The source
    // discrimination (machinery iff the review failed, content iff the
    // request was judged) lives in resolveMapping — same rule as the
    // cache-hit gate above.
    return verdict;
  };

  // Top-level fail-safe: an unexpected throw anywhere in the pipeline
  // (query.checkPermission, an injected log call, a mapping bug) defers to
  // the human decision — the chain link never crashes the host's ask flow.
  return async (details, query, log) => {
    try {
      return await authorize(details, query, log);
    } catch (e) {
      const message = normalizeAndRedactText(errorMessage(e));
      // A crashed review must not look like one that raised no objection: the
      // cause reaches the operator, and the audit trail gets a record. A gate
      // may already have recorded a decision for this requestId (the same group
      // in the report) — the second record is what tells the reader the run then
      // crashed.
      bestEffort(() =>
        deps.notify(
          `automatic review failed, asking you to decide; ${message}`,
          // Error-grade, like the breaker's total trip: the review
          // function is DOWN and recovery needs the operator's hand.
          "error",
        ),
      );
      bestEffort(() =>
        log.debug(
          SHORT_CIRCUIT_EVENT,
          shortCircuit(details.requestId, undefined, PRE_CALL_MACHINERY_KINDS.internalError, {
            error: message,
          }),
        ),
      );
      bestEffort(() =>
        log.review(DECISION_EVENT, DecisionRecord.internalError(details.requestId, undefined)),
      );
      return { kind: "defer" };
    }
  };
}
