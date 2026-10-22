/**
 * Decision record: the audit-log entry emitted at each decision gate in the
 * review pipeline.
 *
 * Every gate's record shares its common fields through `DecisionBase`; this
 * module is the single source of truth — the shared fields are captured
 * once, and each gate's constructor adds only what's specific to it.
 *
 * Log-stream doctrine: the REVIEW stream (log.review, always on) carries one bounded decision
 * record per REVIEWER-RELEVANT gate — the model gate, the circuit breaker, and the reviewer's
 * pre-call failures (no target, model unresolved, auth failed, transcript error). Pass-through
 * gates that add no judgment — policy-decided (the policy already ruled; the link defers) and
 * cache-hit (a replay of the recorded model verdict) — go to the DEBUG stream. Everything verbose
 * or diagnostic — raw replies (defer failures only), call-error records, cache-miss telemetry,
 * transcript-error short-circuits, and empty-reply stop-reason details — also goes to DEBUG
 * (log.debug, written only while the operator has the permission system's debugLog on). Do not
 * promote verbose payloads to the review stream; never demote reviewer judgment.
 */

import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionCheckResult,
  PermissionState,
} from "@gotgenes/pi-permission-system";

import { DECISION_GATES } from "#src/audit/events.ts";
import type { BreakerVerdict, IrreversibleRuling } from "#src/config/config-schema.ts";
import { PRE_CALL_MACHINERY_KINDS, type PreCallMachineryKind } from "#src/model/machinery-kinds.ts";
import type { ReviewOutcome, VerdictKind } from "#src/model/model-verdict.ts";
import type { HardRuleHit } from "#src/review/screen/hard-rules.ts";
import { normalizeAndRedactText, truncateMiddle } from "#src/utils.ts";

/** The audit-log correlation slice every call context carries (log + request id). */
export interface AuditCorrelation {
  /** Audit log for call-failure and diagnostic records. */
  log: AuthorizerLog;
  /** Request id for audit-log correlation (matches the gate's permission-review entry). */
  requestId: string;
}

/** Shared context captured once for every decision record. */
export interface DecisionBase {
  /** The ask's request id (correlates with the gate's permission-review entry). */
  requestId: string;
  /** The tool surface being reviewed; absent on the no-target gate where it could not be resolved. */
  surface: string | undefined;
  /** The value being authorized (command, tool name, path, etc.); absent on the no-target gate. */
  target: string | undefined;
}

/** The model gate's facts: everything one model call contributes to its record. */
export interface ModelGateFacts {
  /** Shared decision-record context. */
  base: DecisionBase;
  /** The reviewer model id that was called. */
  modelId: string;
  /** Number of transcript lines stripped before the call. */
  strippedCount: number;
  /** The full-review call outcome (verdict, latency, raw reply, etc.). */
  reviewOutcome: ReviewOutcome;
  /**
   * The trusted-intent context fingerprint (same value as the verdict-cache
   * key's context hash) — lets audit readers tell same-context repetitions
   * (routine) from cross-context ones (each occurrence was a separate
   * judgment call).
   */
  contextHash: string;
  /**
   * The caller's pre-sanitized defer reply (the pipeline sanitizes one for
   * its debug event and hands it here so the same text is not processed
   * twice). Optional: without it the record sanitizes the outcome's raw
   * reply itself.
   */
  deferReplySanitized?: string;
  /**
   * The latest trusted user message the intent check judged against.
   * Carried beside the outcome, not on it: the transcript is the single
   * source, and the engine's result stays unmutated.
   */
  anchorText?: string;
}

/**
 * A complete audit record. The shared fields are always present; each
 * gate adds its specifics. The index signature admits gate-specific fields
 * without a per-gate type explosion.
 */
export interface DecisionRecordEntry extends DecisionBase {
  /** Which decision gate produced this record. */
  gate: string;
  /** Whether the model was called for this decision. */
  modelCalled: boolean;
  /** The verdict kind (allow / deny / defer). */
  verdict: VerdictKind;
  /** The verdict kind the link emitted when the mode mapped it (set by mapped()). */
  emittedVerdict?: VerdictKind;
  /** The effective mode that triggered the mapping. */
  mode?: string;
  /**
   * The human-readable reason emitted when the mode mapping introduced one —
   * or, on a floored ask, the floor's own reason (the operator notice, named
   * beside `floorFacts`; the returned defer itself carries no agent reason).
   */
  emittedReason?: string;
  /**
   * The deterministic facts that met the reviewer's allow. The gate stays
   * `model` or `cache-hit`: the floor re-judges nothing, it names what the
   * facts already proved.
   */
  floorFacts?: readonly string[];
  /**
   * How the mode disposed of those facts: the built-in ask, the operator's
   * `allow` (the record then shows an allow the reviewer also allowed), or
   * the operator's `deny`. Absent when no floor fired. Narrowed to the config
   * enum so the audit side cannot drift from the option the operator wrote.
   */
  floorRuling?: IrreversibleRuling;
  /** Gate-specific fields (policyState, modelId, latencyMs, etc.). */
  [k: string]: unknown;
}

/** Fields available on a policy gate result, narrowed for the record. */
export interface PolicyGateFacts {
  /** The policy's decision state (allow / deny / ask). */
  state: PermissionState;
  /** Which rule source contributed the winning rule. */
  origin: PermissionCheckResult["origin"];
  /** The matched rule pattern, or null if none. */
  matchedPattern: string | null;
  /** The command spelling the matched rule matched, or null when the typed text decided. */
  matchedSpelling: string | null;
}

/** A short-circuit debug record (supplementary to the decision gates). */
export interface ShortCircuitRecord {
  /** The ask's request id. */
  requestId: string;
  /** The tool surface, or undefined if not yet resolved. */
  surface: string | undefined;
  /** Why the ask short-circuited — a pre-call machinery kind (single-sourced). */
  reason: PreCallMachineryKind;
  /** Extra context (e.g. the transcript error message). */
  [k: string]: unknown;
}

/** A model-reply debug record (the raw model text, for debugging). */
export interface ModelReplyRecord {
  /** The ask's request id. */
  requestId: string;
  /** The reviewer model id ("provider/model"). */
  modelId: string;
  /** The raw model reply text. */
  rawReply: string;
  /** Admits the record to be passed as an AuthorizerLog details payload. */
  [k: string]: unknown;
}

/**
 * A cache-lookup debug record (emitted on miss only; hits are covered by the cache-hit decision
 * record).
 */
export interface CacheLookupRecord {
  /** The ask's request id. */
  requestId: string;
  /** The tool surface being reviewed. */
  surface: string;
  /** Why the cache missed (disabled / no-entry / context-changed). */
  missReason: string;
  /** Admits the record to be passed as an AuthorizerLog details payload. */
  [k: string]: unknown;
}

/** A coverage-gap debug record (an ask outside this link's jurisdiction). */
export interface CoverageRecord {
  /** The ask's request id. */
  requestId: string;
  /** Why the ask is outside coverage (e.g. surface-unmatched). */
  reason: string;
  /** Admits the record to be passed as an AuthorizerLog details payload. */
  [k: string]: unknown;
}

/**
 * The deny reason emitted when the circuit breaker trips. Shared by the
 * pipeline (which returns it to the caller) and {@link DecisionRecord.breaker}
 * (which records it in the audit log) so the string cannot drift.
 */
export const BREAKER_DENY_REASON = "Circuit breaker tripped: too many denials this session";

/**
 * Sentinel for the `rawReply` audit field when a clean verdict's raw text is
 * omitted. Distinct from null so it can't be confused with the throw-based
 * absence — see the field comment in {@link DecisionRecord.model}.
 */
const CLEAN_VERDICT_OMITTED = "(clean verdict, rawReply omitted)";

/**
 * Longest raw model reply the audit streams keep. The record is written to the
 * review log, and MAX_RAW_REPLY_CHARS bounds what the logs accumulate;
 * mid-truncation keeps the tail, so a defer stays replayable.
 */
export const MAX_RAW_REPLY_CHARS = 2000;

/**
 * Sanitize a raw model reply for the audit streams: redact once, then bound.
 *
 * @param text - The raw reply text.
 * @returns The reply with credentials redacted and its length bounded.
 */
export function sanitizeRawReply(text: string): string {
  return truncateMiddle(normalizeAndRedactText(text), MAX_RAW_REPLY_CHARS);
}

/**
 * Pick the rawReply value for the decision record; the three reply states it
 * distinguishes are documented on the field in {@link DecisionRecord.model}.
 *
 * @param reviewOutcome - The full-review call outcome.
 * @param preSanitized - The caller's already-sanitized defer reply, when it
 *   sanitized one for its own debug stream (the pipeline does — same text).
 *   Sanitized here only when absent.
 * @returns The rawReply value for the audit record: a sentinel for a clean verdict, the sanitized
 *   text for defer-with-reply, or null when the call threw.
 */
function rawReplyForRecord(reviewOutcome: ReviewOutcome, preSanitized?: string): string | null {
  if (reviewOutcome.verdict.kind === "defer") {
    // The reply is redacted exactly once — by the caller when it hands
    // `preSanitized`, here otherwise — so the record carries no more than the
    // debug stream does (the model may parrot prompt content: credentials,
    // working directory). Bounded on the same reasoning: how long a reply is
    // belongs to the log's budget, not to the model's.
    return reviewOutcome.rawReply !== undefined
      ? truncateMiddle(
          preSanitized ?? normalizeAndRedactText(reviewOutcome.rawReply),
          MAX_RAW_REPLY_CHARS,
        )
      : null;
  }
  return CLEAN_VERDICT_OMITTED;
}

/**
 * The record prefix for a gate that answered without calling the model: its
 * name and the uncalled flag. Verdict and gate specifics follow at each call
 * site — the silent gates share only this prefix.
 *
 * @param base - Shared decision-record context (the no-target gates build the
 *   identity they have).
 * @param gate - The gate name.
 * @returns The record prefix.
 */
function uncalledGate(
  base: Pick<DecisionBase, "requestId" | "surface" | "target">,
  gate: string,
): Pick<DecisionRecordEntry, "requestId" | "surface" | "target" | "gate" | "modelCalled"> {
  return { ...base, gate, modelCalled: false };
}

export const DecisionRecord = {
  /**
   * Policy already decided (allow/deny) — the link defers.
   *
   * @param base - Shared decision-record context.
   * @param policy - The policy gate's resolved facts.
   * @returns A decision record for the policy-decided gate.
   */
  policyDecided(base: DecisionBase, policy: PolicyGateFacts): DecisionRecordEntry {
    return {
      ...uncalledGate(base, DECISION_GATES.policyDecided),
      verdict: "defer",
      policyState: policy.state,
      policyOrigin: policy.origin,
      matchedPattern:
        policy.matchedPattern === null ? null : normalizeAndRedactText(policy.matchedPattern),
      matchedSpelling:
        policy.matchedSpelling === null ? null : normalizeAndRedactText(policy.matchedSpelling),
      deferKind: `policy-${policy.state}`,
    };
  },

  /**
   * The deterministic screen hard-denied — no model was called.
   *
   * @param base - Shared decision-record context.
   * @param hit - The matched rule's stable id and the reason emitted.
   * @returns A decision record for the screen gate.
   */
  screenDecided(base: DecisionBase, hit: HardRuleHit): DecisionRecordEntry {
    return {
      ...uncalledGate(base, DECISION_GATES.screen),
      verdict: "deny",
      rule: hit.rule,
      reason: hit.reason,
      riskLevel: "critical",
    };
  },

  /**
   * Circuit breaker tripped — short-circuits to the breaker's verdict.
   *
   * @param base - Shared decision-record context.
   * @param cbVerdict - The verdict the circuit breaker forces (deny or defer).
   * @returns A decision record for the circuit-breaker gate.
   */
  breaker(base: DecisionBase, cbVerdict: BreakerVerdict): DecisionRecordEntry {
    return {
      ...uncalledGate(base, DECISION_GATES.circuitBreaker),
      verdict: cbVerdict,
      reason: cbVerdict === "deny" ? BREAKER_DENY_REASON : undefined,
      // The defer kind rides the same constant as the gate: one source for the
      // wire string, so a drifted literal cannot blind a reader to this stage.
      deferKind: cbVerdict === "defer" ? DECISION_GATES.circuitBreaker : null,
    };
  },

  /**
   * Model could not be resolved from the registry — defer.
   *
   * @param base - Shared decision-record context.
   * @param modelId - The model id that failed to resolve.
   * @returns A decision record for the model-unresolved gate.
   */
  modelUnresolved(base: DecisionBase, modelId: string): DecisionRecordEntry {
    return {
      ...uncalledGate(base, PRE_CALL_MACHINERY_KINDS.modelUnresolved),
      verdict: "defer",
      modelId,
      deferKind: PRE_CALL_MACHINERY_KINDS.modelUnresolved,
    };
  },

  /**
   * No review target could be extracted — the review never opened. A
   * permanent property of the ask's shape (the surface never yields a
   * target), not a transient reviewer failure; still a machinery-lane
   * gate because the review never started.
   *
   * @param requestId - The ask's request id.
   * @param surface - The resolved surface, if any.
   * @returns A decision record for the no-target gate.
   */
  noTarget(requestId: string, surface: string | undefined): DecisionRecordEntry {
    return {
      ...uncalledGate({ requestId, surface, target: undefined }, PRE_CALL_MACHINERY_KINDS.noTarget),
      verdict: "defer",
      deferKind: PRE_CALL_MACHINERY_KINDS.noTarget,
    };
  },

  /**
   * The pipeline threw outside its wrapped paths — nothing was judged, and
   * the ask fell back to the human decision.
   *
   * @param requestId - The ask's request id.
   * @param surface - The resolved surface, if any.
   * @returns A decision record for the internal-error gate.
   */
  internalError(requestId: string, surface: string | undefined): DecisionRecordEntry {
    return {
      ...uncalledGate(
        { requestId, surface, target: undefined },
        PRE_CALL_MACHINERY_KINDS.internalError,
      ),
      verdict: "defer",
      deferKind: PRE_CALL_MACHINERY_KINDS.internalError,
    };
  },

  /**
   * Transcript stripping failed — the review never opened.
   *
   * @param base - Shared decision-record context.
   * @returns A decision record for the transcript-error gate.
   */
  transcriptError(base: DecisionBase): DecisionRecordEntry {
    return {
      ...uncalledGate(base, PRE_CALL_MACHINERY_KINDS.transcriptError),
      verdict: "defer",
      deferKind: PRE_CALL_MACHINERY_KINDS.transcriptError,
    };
  },

  /**
   * Auth resolution failed — defer.
   *
   * @param base - Shared decision-record context.
   * @param modelId - The model id whose auth failed.
   * @param error - The auth error message.
   * @returns A decision record for the auth-failed gate.
   */
  authFailed(base: DecisionBase, modelId: string, error: string): DecisionRecordEntry {
    return {
      ...uncalledGate(base, PRE_CALL_MACHINERY_KINDS.authFailed),
      verdict: "defer",
      modelId,
      deferKind: PRE_CALL_MACHINERY_KINDS.authFailed,
      error,
    };
  },

  /**
   * Verdict cache hit — returns the cached verdict without a model call.
   *
   * @param base - Shared decision-record context.
   * @param verdict - The cached verdict (full, so a deny reason can be persisted).
   * @returns A decision record for the cache-hit gate.
   */
  cacheHit(base: DecisionBase, verdict: AuthorizerVerdict): DecisionRecordEntry {
    return {
      ...uncalledGate(base, DECISION_GATES.cacheHit),
      verdict: verdict.kind,
      // Persist the deny reason from the original model call so audit readers
      // can see why a cached deny was returned without looking up the earlier
      // model-gate record.
      reason: verdict.kind === "deny" ? verdict.reason : undefined,
    };
  },

  /**
   * The model was called and returned a verdict.
   *
   * @param facts - The model gate's facts.
   * @returns A decision record for the model gate.
   */
  model(facts: ModelGateFacts): DecisionRecordEntry {
    const {
      base,
      modelId,
      strippedCount,
      reviewOutcome,
      contextHash,
      deferReplySanitized,
      anchorText,
    } = facts;
    return {
      ...base,
      gate: DECISION_GATES.model,
      modelCalled: true,
      modelId,
      latencyMs: reviewOutcome.latencyMs,
      // Present only when the empty-reply retry fired (2 attempts); 1 is
      // the silent default, keeping the record minimal for the common path.
      attempts: reviewOutcome.attempts,
      strippedCount,
      contextHash,
      // Key name avoids "authorization": upstream masks such keys in logs.
      anchorText: anchorText ?? null,
      verdict: reviewOutcome.verdict.kind,
      // Persist the sanitized model explanation for deny or defer. For
      // defer, `deferKind` carries the classification (timeout / model-defer
      // / etc.) and `reason` carries the model's natural-language
      // explanation of what is unclear.
      reason:
        reviewOutcome.verdict.kind === "deny"
          ? reviewOutcome.verdict.reason
          : reviewOutcome.deferReason,
      deferKind: reviewOutcome.deferKind ?? null,
      // The reviewer's directional inclination on a defer (audit-only; the
      // lean routes, it never surfaces — null when neutral or not a defer).
      lean: reviewOutcome.lean ?? null,
      riskLevel: reviewOutcome.riskLevel ?? null,
      // Reply and call-error diagnostics ride along so the review log stands
      // alone: an operator reads that the call threw without the debug stream.
      diagnostic: reviewOutcome.diagnostic ?? null,
      // Token usage and its catalog-priced cost, when the backend reported
      // token counts — the one place a cost stays visible without parsing
      // rawReply. Null when the call threw before producing usage.
      usage: reviewOutcome.usage ?? null,
      // rawReply distinguishes three states so audit readers can tell them apart:
      //  - defer with a reply (no-json / invalid-verdict-value / model-defer):
      //    keep the raw text — it's the operator's clue to why parsing failed.
      //  - defer without a reply (timeout / call-failed / empty-reply): the
      //    call threw before producing text or returned an empty body, so null
      //    marks a genuine absence.
      //  - clean allow/deny: the JSON parsed; the verdict, reason (deny only),
      //    and riskLevel are already in the structured fields above, so the
      //    raw text is omitted via a sentinel (NOT null, so it can't be
      //    confused with the throw-based defer absence above).
      rawReply: rawReplyForRecord(reviewOutcome, deferReplySanitized),
    };
  },
};

/**
 * Annotate a decision record when the mode mapped the model's
 * verdict to a different emitted kind. The record's `verdict` keeps the
 * MODEL's judgment (with its reason and riskLevel); `emittedVerdict` names
 * what the link actually returned, and `mode` names which mode
 * mapped it (the default lane routes flags to human review, the strict
 * lane tightens uncertainty to denial, auto denies every deny and every
 * danger-leaned doubt, and passes only benign-leaned
 * uncertainty — the annotation covers every direction).
 *
 * @param record - The decision record for the model or cache-hit gate.
 * @param mode - The effective mode that triggered the mapping.
 * @param emittedKind - The verdict kind the link emitted after mapping.
 * @param emittedReason - The human-readable deny/defer/x reason that was
 *   emitted, when the mode mapping introduced one.
 * @returns The annotated decision record.
 */
export function mapped(
  record: DecisionRecordEntry,
  mode: string,
  emittedKind: VerdictKind,
  emittedReason?: string,
): DecisionRecordEntry {
  // The emitted reason rides along so the audit trail shows what the agent
  // actually received — reconstructing it from the deferKind would leave
  // the reader guessing.
  return { ...record, emittedVerdict: emittedKind, mode, emittedReason };
}

/**
 * Build a short-circuit debug record.
 *
 * @param requestId - The ask's request id.
 * @param surface - The tool surface, or undefined if not yet resolved.
 * @param reason - Why the ask short-circuited (a pre-call machinery kind).
 * @param extra - Additional context fields to merge into the record.
 * @returns A short-circuit debug record.
 */
export function shortCircuit(
  requestId: string,
  surface: string | undefined,
  reason: PreCallMachineryKind,
  extra?: Record<string, unknown>,
): ShortCircuitRecord {
  return { requestId, surface, reason, ...extra };
}

/**
 * Build a model-reply debug record.
 *
 * @param requestId - The ask's request id.
 * @param modelId - The reviewer model id ("provider/model").
 * @param rawReply - The raw model reply text.
 * @returns A model-reply debug record.
 */
export function modelReply(requestId: string, modelId: string, rawReply: string): ModelReplyRecord {
  return { requestId, modelId, rawReply };
}

/**
 * Build a cache-lookup debug record (miss only).
 *
 * @param requestId - The ask's request id.
 * @param surface - The tool surface being reviewed.
 * @param missReason - Why the cache missed (disabled / no-entry / context-changed).
 * @returns A cache-lookup debug record.
 */
export function cacheLookup(
  requestId: string,
  surface: string,
  missReason: string,
): CacheLookupRecord {
  return { requestId, surface, missReason };
}

/**
 * Build a coverage-gap debug record.
 *
 * Deliberately outside the machinery taxonomy: an ask outside this link's
 * jurisdiction is not a reviewer failure, only a coverage breadcrumb so a
 * "thought-covered but never reviewed" misconfig is discoverable.
 *
 * @param requestId - The ask's request id.
 * @param reason - Why the ask is outside coverage (e.g. surface-unmatched).
 * @returns A coverage-gap debug record.
 */
export function coverage(requestId: string, reason: string): CoverageRecord {
  return { requestId, reason };
}
