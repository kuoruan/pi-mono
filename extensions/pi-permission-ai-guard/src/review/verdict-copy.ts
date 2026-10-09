/**
 * The mode mapping copy: every human- or agent-facing string the mapping
 * produces. Deciding lives in verdict-rule; this module never branches on
 * the ladder — it renders what the rule decided.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { Mode } from "#src/config/config-schema.ts";
import type { MachineryFailureKind } from "#src/model/machinery-kinds.ts";
import type { RiskLevel } from "#src/model/model-verdict.ts";

/**
 * The deny reason when the reviewer's own uncertainty is denied with no
 * clarification request attached.
 *
 * @param mode - The effective mode.
 * @returns The deny teaching reason.
 */
export function uncertainDenyReason(mode: Mode): string {
  return `reviewer was unsure, so ${mode} mode denied the request`;
}

/**
 * The human notice for a machinery-forced defer: the deferred ask lands on the
 * operator with no dialog context of its own, so the line names the failure
 * kind. The host's own level prefix would double a structural colon of ours.
 *
 * @param kind - The classified machinery failure kind.
 * @returns The notification message.
 */
export function machineryDeferNotice(kind: MachineryFailureKind): string {
  return `reviewer could not complete the review (${kind}), deferring to you`;
}

/**
 * The deny reason for a machinery-failure denial: the agent sees why the
 * review could not complete instead of a silent deny. Mode-parameterized
 * so audit readers see which policy produced the deny.
 *
 * @param deferKind - The classified failure kind, if any.
 * @param mode - The effective mode.
 * @returns The deny teaching reason.
 */
export function machineryDenyReason(
  deferKind: MachineryFailureKind | undefined,
  mode: Mode,
): string {
  return `reviewer could not complete the review (${deferKind ?? "unknown"}), so ${mode} mode denied the request`;
}

/**
 * Which kind of deny a terminal reason comes from — selects the agent
 * instruction variant.
 *
 * - `"content"`: the review COMPLETED and judged the request itself dangerous (a model deny, or
 *   `strict`'s mapping of the reviewer's own uncertain defer). The agent's correct move is to stop
 *   pursuing this action and let the user re-request it explicitly.
 * - `"machinery"`: the review FAILED (a reviewer-machinery denial — e.g. an unresolved model, auth
 *   failure, unparseable reply, timeout, or the breaker; the full taxonomy lives in
 *   machinery-kinds). The request was never judged; retrying later is legitimate.
 */
export type DenyInstructionSource = "content" | "machinery";

/**
 * The behavioral instruction for a content deny (the request was judged). No
 * trailing period: the host's agent-side reason render appends its own.
 */
const CONTENT_DENY_INSTRUCTION =
  "Automatic review denied this, not the user. Do not rephrase, retry, or work around it; if the user wants it, they should ask explicitly";

const MACHINERY_DENY_INSTRUCTION =
  "Automatic review failed (not the request). Retry later, or ask the user to request it if urgent";

/**
 * Append the agent-facing behavioral instruction to a terminal deny reason.
 * Instruction first: the host's agent-side render already fronts its own
 * attribution sentence, and the teaching reason says WHAT was dangerous but not
 * what to do about it. Two variants, because the correct move differs: content
 * denies must not be retried or rephrased; machinery denies were never judged
 * and may be retried later.
 *
 * Applies ONLY to the returned verdict's reason — the audit record's
 * `emittedReason` and the operator notify lines keep the un-instructed
 * mapping reason (agent-channel copy, not an audit fact).
 *
 * @param reason - The mapped deny reason (the teaching reason), or
 *   undefined when the deny carries none (the instruction still stands
 *   alone — the agent needs the behavioral guidance regardless).
 * @param source - Which kind of deny produced the reason.
 * @returns The instruction followed by the reason (or the instruction
 *   alone when no reason was present).
 */
export function withAgentInstruction(
  reason: string | undefined,
  source: DenyInstructionSource,
): string {
  const instruction =
    source === "machinery" ? MACHINERY_DENY_INSTRUCTION : CONTENT_DENY_INSTRUCTION;
  return reason ? `${instruction}; ${reason}` : instruction;
}

/**
 * Format a review latency for an operator-facing notify line: whole
 * milliseconds under a second, one-decimal seconds above. The single
 * decimal keeps the tail short at notify grade (`(1.2s)` reads faster
 * than `(1234ms)`); sub-second reviews stay in ms where the unit is
 * exact.
 *
 * @param ms - The latency in milliseconds.
 * @returns The formatted duration (`123ms` or `1.2s`).
 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A fresh review's cost: its total model-call cost in milliseconds. */
interface FreshReviewCost {
  kind: "fresh";
  latencyMs: number;
}

/** A cache hit's cost: a replay, not a measurement, so it names itself. */
interface CachedReviewCost {
  kind: "cached";
}

/**
 * What an approval notice's duration tail reports: a fresh review names its
 * cost; a cache hit names itself.
 */
export type ReviewCost = FreshReviewCost | CachedReviewCost;

interface ReviewerApprovalOrigin {
  kind: "reviewer";
}

/**
 * A mode mapping's approval: carries the mode so a lone approval line
 * still names the policy that let the request through.
 */
interface ModeApprovalOrigin {
  kind: "mode";
  mode: Mode;
}

/**
 * Which voice approved the request: the reviewer's own allow, or the
 * mode's mapping of a non-allow verdict.
 */
type ApprovalOrigin = ReviewerApprovalOrigin | ModeApprovalOrigin;

/**
 * Render an opt-in approval notice: the approval's voice plus its cost
 * tail. Never carries the command or target (they may hold secrets).
 *
 * @param origin - Who approved the request (reviewer or mode).
 * @param cost - The review's cost (fresh latency or cached replay).
 * @returns The notification message.
 */
export function approvalNotice(origin: ApprovalOrigin, cost: ReviewCost): string {
  const base =
    origin.kind === "reviewer"
      ? "reviewer approved this request"
      : `mode (${origin.mode}) auto-approved this request`;
  return cost.kind === "fresh" ? `${base} (${formatDuration(cost.latencyMs)})` : `${base} (cached)`;
}

/**
 * What actually happened to the request the reviewer denied: the deny held
 * (`"denied"`), or the mode softened it into a human ask (`"asked"`).
 */
type EscalationOutcome = "denied" | "asked";

/**
 * Surface the reviewer's reasoning when the mode hands a model deny to the
 * human — the permission dialog renders only the request, so
 * without this the reviewer's judgment is audit-log-only.
 *
 * @param verdict - The model's verdict (a deny at every call site).
 * @param riskLevel - The risk level attached to the deny, if any.
 * @param outcome - The request's real outcome ({@link EscalationOutcome}) —
 *   the tail appears only when it diverges from the fact sentence.
 * @returns The notification message.
 */
export function escalationMessage(
  verdict: AuthorizerVerdict,
  riskLevel: RiskLevel | undefined,
  outcome: EscalationOutcome,
): string {
  const reason = verdict.kind === "deny" ? verdict.reason : undefined;
  // The host renders its own level prefix and separator, so a structural colon of
  // ours reads as two; parentheses and a semicolon carry the detail instead. The
  // reason goes out whole: the operator must be able to read (and, for a
  // clarification, answer) the model's full text, however long it runs. The audit
  // record keeps it too. The outcome tail appears only when it diverges from the
  // fact sentence.
  const fact = `reviewer denied this request${riskLevel ? ` (risk ${riskLevel})` : ""}`;
  const outcomeClause = outcome === "asked" ? ", asking you to decide instead" : "";
  return reason ? `${fact}${outcomeClause}; ${reason}` : `${fact}${outcomeClause}`;
}

/**
 * The fail-open notice: the mode passed something the reviewer did not allow, so
 * the line names the tier that still blocks. A loosened mode never reads as a
 * blanket pass.
 *
 * @param mode - The mode that auto-approved the request.
 * @returns The notification message.
 */
export function failOpenNotice(mode: Mode): string {
  const loosened =
    mode === "lenient"
      ? "uncertainty; soft denials still ask"
      : "non-allow verdicts; hard-tier denials still block";
  return `${mode} auto-approves ${loosened}`;
}
