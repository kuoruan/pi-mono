/**
 * The verdict taxonomy shared by both lanes: the outcome shape a lane
 * returns, its defer kinds, the availability reasons failover reads, and the
 * verdict / risk / lean vocabularies. Lane-neutral by construction — the chat
 * lane's tolerant JSON text parser lives with the chat lane
 * (`engines/chat/verdict-parser.ts`), and the failure-classification tables
 * that produce the availability reasons live in `review/failure-taxonomy.ts`.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

/**
 * Safe availability-failure category for ordered failover; never an error
 * body. Adapters report one of these when the backend could not serve the
 * request; the pool advances to the next endpoint on it.
 */
export type AvailabilityReason =
  | "quota"
  | "timeout"
  | "connection"
  | "model-unresolved"
  | `http-${number}`;

/** Why a model call deferred (for logging/debugging). */
export type ModelCallDeferKind =
  | "empty-reply"
  | "no-json"
  | "invalid-verdict-value"
  | "timeout"
  | "call-failed"
  | "model-defer";

/**
 * The reviewer's directional inclination on a defer verdict: which way it
 * would decide if forced to pick now. Absent means genuinely neutral.
 * Routing-only signal — never surfaced to the human (dialogs and notify
 * lines carry the clarification question, not the lean), so it cannot
 * anchor the operator's judgment.
 */
export type VerdictLean = "allow" | "deny";

/** Result of a model review call. */
export interface ReviewOutcome {
  /** The verdict (allow / deny / defer). */
  verdict: AuthorizerVerdict;
  /** Classified defer reason (timeout / empty-reply / no-json / model-defer / etc.). */
  deferKind?: ModelCallDeferKind;
  /** Safe availability failure category for ordered failover; never an error body. */
  availabilityReason?: AvailabilityReason;
  /** Model explanation for a defer verdict, retained for audit logging. */
  deferReason?: string;
  /**
   * The reviewer's directional inclination on a defer (which way it would
   * decide if forced); undefined means neutral. Present only on
   * model-defer outcomes.
   */
  lean?: VerdictLean;
  /** Model call latency in milliseconds (cumulative across attempts). */
  latencyMs: number;
  /** How many executeCall attempts produced this outcome (1, or 2 after the empty-reply retry). */
  attempts?: number;
  /** Raw model reply (for debug logging). */
  rawReply?: string;
  /** Risk level from the model verdict, if provided. */
  riskLevel?: RiskLevel;
  /**
   * Empty/aborted-reply diagnostics, present only when the reply carried
   * no text — see {@link ReviewOutcomeDiagnostic}.
   */
  diagnostic?: ReviewOutcomeDiagnostic;
  /** The latest trusted user message the intent check judged against (audit-only). */
  anchorText?: string;
}

/**
 * Why a model reply carried no text, captured when the reply is empty or
 * aborted. Persisted into the decision record so the review log is
 * self-diagnosing even with the permission system's debug log disabled.
 */
export interface ReviewOutcomeDiagnostic {
  /** The provider stop reason (null when unknown). */
  stopReason: string | null;
  /** The UNADJUSTED provider stop reason (through the aborted reclassification). */
  rawStopReason: string | null;
  /** Content-block types present in the reply ("" text implies "text"). */
  contentTypes: string[];
  /** Sanitized provider error message, when the reply carried one. */
  errorMessage: string | null;
}

/**
 * Risk level assessed by the model (optional, for audit logging). The chat
 * parser derives its runtime set from this type; the type argument cannot
 * catch an omission, so a new member has to be added there too.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * The valid verdict values, derived from {@link AuthorizerVerdict}["kind"] —
 * the upstream type is the single source of truth. Used to validate the
 * `verdict` field the model returns in its JSON reply.
 */
export type VerdictKind = AuthorizerVerdict["kind"];

/**
 * A non-allow verdict's origin kind (deny or defer) — the mapping's input
 * origins, and exactly the lane kinds a machinery lane may target
 * (never allow). Derived from the upstream verdict, which is the single
 * source of truth.
 */
export type VerdictOrigin = Exclude<VerdictKind, "allow">;

/**
 * The deny reason attached when the model denies without one — the prompt
 * demands a reason, but a terse model may omit it; this default keeps the
 * teaching signal present. Shared: the classifier lane synthesizes its
 * deny reasons from the danger-category name and falls back to this too.
 */
export const GENERIC_DENY_REASON =
  "This action may be unsafe. Verify the target and intent before retrying.";
