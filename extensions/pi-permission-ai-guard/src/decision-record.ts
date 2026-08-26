/**
 * Decision record: the audit-log entry emitted at each decision gate in the
 * review pipeline.
 *
 * Previously each of the six gates (policy-decided, circuit-breaker,
 * model-unresolved, auth-failed, cache-hit, model) hand-built its own
 * `log.review(DECISION_EVENT, {...})` payload with a different ad-hoc shape.
 * The audit schema — which fields every decision record must carry — existed
 * only implicitly, duplicated across six literals. This module is the single
 * source of truth: the shared fields are captured once in `DecisionBase`,
 * and each gate's constructor adds only what's specific to it.
 *
 * The event constants live here so callers don't redeclare them.
 */

import type {
  AuthorizerVerdict,
  PermissionCheckResult,
  PermissionState,
} from "@gotgenes/pi-permission-system";

import type { BreakerVerdict } from "./config-schema.ts";
import type { ModelCallDeferKind, ReviewOutcome } from "./verdict.ts";

/** Shared context captured once for every decision record. */
export interface DecisionBase {
  /** The ask's request id (correlates with the gate's permission-review entry). */
  requestId: string;
  /** The tool surface being reviewed. */
  surface: string;
  /** The value being authorized (command, tool name, path, etc.). */
  target: string;
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
  verdict: AuthorizerVerdict["kind"];
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
}

/** A short-circuit debug record (supplementary to the decision gates). */
export interface ShortCircuitRecord {
  /** The ask's request id. */
  requestId: string;
  /** The tool surface, or undefined if not yet resolved. */
  surface: string | undefined;
  /** Why the ask short-circuited (e.g. "no-target", "transcript-error"). */
  reason: string;
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

/** A model-call-error debug record (emitted when the model call throws). */
export interface ModelCallErrorRecord {
  /** The ask's request id. */
  requestId: string;
  /** The classified defer kind (timeout / call-failed). */
  deferKind: ModelCallDeferKind;
  /** The sanitized error message. */
  error: string;
  /** Admits the record to be passed as an AuthorizerLog details payload. */
  [k: string]: unknown;
}

/** The event constants live here so callers don't redeclare them. */
export const DECISION_EVENT = "ai_guard.decision";

export const SHORT_CIRCUIT_EVENT = "ai_guard.short_circuit";

export const MODEL_REPLY_EVENT = "ai_guard.model_reply";

export const CACHE_LOOKUP_EVENT = "ai_guard.cache_lookup";

export const MODEL_CALL_ERROR_EVENT = "ai_guard.model_call_error";

/**
 * The deny reason emitted when the circuit breaker trips. Shared by the
 * pipeline (which returns it to the caller) and {@link DecisionRecord.breaker}
 * (which records it in the audit log) so the string cannot drift.
 */
export const BREAKER_DENY_REASON = "Circuit breaker tripped: too many denials this session";

/**
 * Sentinel for the `rawReply` audit field when no verbatim reply is recorded.
 * The model call produced a parseable clean verdict (allow/deny); the JSON is
 * already captured in the structured verdict fields, so the raw text is
 * omitted. Distinct from null so it can't be confused with the throw-based
 * absence (timeout / call-failed / empty-reply).
 */
const CLEAN_VERDICT_OMITTED = "(clean verdict, rawReply omitted)";

/**
 * Pick the rawReply value for the decision record, distinguishing the
 * three reply states (defer-with-text / defer-threw / clean verdict). See
 * the field comment in {@link DecisionRecord.model} for the rationale.
 *
 * @param reviewOutcome - The full-review call outcome.
 * @returns The rawReply value for the audit record: a sentinel for a clean verdict, the raw text
 *   for defer-with-reply, or null when the call threw.
 */
function rawReplyForRecord(reviewOutcome: ReviewOutcome): string | null {
  if (reviewOutcome.verdict.kind === "defer") {
    // defer: keep the raw text when the call produced any (no-json / invalid-
    // verdict-value / model-defer); null when it threw before replying
    // (timeout / call-failed) or returned an empty body (empty-reply), so the
    // absence of text stays a genuine null.
    return reviewOutcome.rawReply !== undefined ? reviewOutcome.rawReply : null;
  }
  // Clean allow/deny: the JSON parsed; verdict, reason (deny only), and
  // riskLevel are already in the structured record fields, so the raw text is
  // omitted via a sentinel (not null, to stay distinct from the throw-based
  // defer absence above).
  return CLEAN_VERDICT_OMITTED;
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
      ...base,
      gate: "policy-decided",
      modelCalled: false,
      verdict: "defer",
      policyState: policy.state,
      policyOrigin: policy.origin,
      matchedPattern: policy.matchedPattern,
      deferKind: `policy-${policy.state}`,
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
      ...base,
      gate: "circuit-breaker",
      modelCalled: false,
      verdict: cbVerdict,
      reason: cbVerdict === "deny" ? BREAKER_DENY_REASON : undefined,
      deferKind: cbVerdict === "defer" ? "circuit-breaker" : null,
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
      ...base,
      gate: "model-unresolved",
      modelCalled: false,
      verdict: "defer",
      modelId,
      deferKind: "model-unresolved",
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
      ...base,
      gate: "auth-failed",
      modelCalled: false,
      verdict: "defer",
      modelId,
      deferKind: "auth-failed",
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
      ...base,
      gate: "cache-hit",
      modelCalled: false,
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
   * @param base - Shared decision-record context.
   * @param modelId - The reviewer model id that was called.
   * @param strippedCount - Number of transcript lines stripped before the call.
   * @param reviewOutcome - The full-review call outcome (verdict, latency, raw reply, etc.).
   * @returns A decision record for the model gate.
   */
  model(
    base: DecisionBase,
    modelId: string,
    strippedCount: number,
    reviewOutcome: ReviewOutcome,
  ): DecisionRecordEntry {
    return {
      ...base,
      gate: "model",
      modelCalled: true,
      modelId,
      latencyMs: reviewOutcome.latencyMs,
      strippedCount,
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
      riskLevel: reviewOutcome.riskLevel ?? null,
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
      rawReply: rawReplyForRecord(reviewOutcome),
    };
  },
};

/**
 * Annotate a decision record when the mode mapped the model's
 * verdict to a different emitted kind. The record's `verdict` keeps the
 * MODEL's judgment (with its reason and riskLevel); `emittedVerdict` names
 * what the link actually returned, and `mode` names which mode
 * mapped it (manual tightens denial to human review, auto tightens
 * uncertainty to denial — the annotation covers both directions).
 *
 * @param record - The decision record for the model or cache-hit gate.
 * @param mode - The effective mode that triggered the mapping.
 * @param emittedKind - The verdict kind the link emitted after mapping.
 * @returns The annotated decision record.
 */
export function mapped(
  record: DecisionRecordEntry,
  mode: string,
  emittedKind: AuthorizerVerdict["kind"],
): DecisionRecordEntry {
  return { ...record, emittedVerdict: emittedKind, mode };
}

/**
 * Build a short-circuit debug record.
 *
 * @param requestId - The ask's request id.
 * @param surface - The tool surface, or undefined if not yet resolved.
 * @param reason - Why the ask short-circuited.
 * @param extra - Additional context fields to merge into the record.
 * @returns A short-circuit debug record.
 */
export function shortCircuit(
  requestId: string,
  surface: string | undefined,
  reason: string,
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
 * Build a model-call-error debug record.
 *
 * @param requestId - The ask's request id.
 * @param deferKind - The classified defer kind (timeout / call-failed).
 * @param error - The sanitized error message.
 * @returns A model-call-error debug record.
 */
export function modelCallError(
  requestId: string,
  deferKind: ModelCallDeferKind,
  error: string,
): ModelCallErrorRecord {
  return { requestId, deferKind, error };
}
