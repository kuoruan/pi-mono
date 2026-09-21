/**
 * The mode mapping copy: every human- or agent-facing string the mapping
 * produces. Deciding lives in verdict-rule; this module never branches on
 * the ladder — it renders what the rule decided.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { Mode } from "#src/config/config-schema.ts";
import type { RiskLevel } from "#src/model/model-verdict.ts";
import { truncateMiddle } from "#src/utils.ts";

import type { MachineryFailureKind } from "./machinery-kinds.ts";

/**
 * The deny reason when the reviewer's own uncertainty is denied with no
 * clarification request attached.
 *
 * @param mode - The effective mode.
 * @returns The deny teaching reason.
 */
export function uncertainDenyReason(mode: Mode): string {
  return `Reviewer was uncertain about this request — ${mode} mode denies uncertain requests`;
}

/**
 * The human notice for a machinery-forced defer — the deferred ask lands on
 * the operator with no dialog context of its own, so the line names the
 * failure kind (doctrine symmetry with the breaker-trip notice). No
 * structural colon: the TUI's own level prefix would double it up.
 *
 * @param kind - The classified machinery failure kind.
 * @returns The notification message.
 */
export function machineryDeferNotice(kind: MachineryFailureKind): string {
  return `reviewer could not complete the review (${kind}) — deferring to you`;
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
  return `reviewer could not complete the review (${deferKind ?? "unknown"}) — ${mode} mode denied the request`;
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
 * The behavioral instruction for a content deny (the request was judged).
 * No trailing period — the host's agent-side reason render appends its
 * own, and a trailing period here would double up.
 */
const CONTENT_DENY_INSTRUCTION =
  "Automatic review denied this, not the user. Do not rephrase, retry, or work around it; if the user wants it, they should ask explicitly";

/**
 * The behavioral instruction for a machinery deny (the review failed).
 * No trailing period — same double-up guard as the content variant.
 */
const MACHINERY_DENY_INSTRUCTION =
  "Automatic review failed (the reviewer, not the request). Retry later, or ask the user to request it explicitly if urgent";

/**
 * Append the agent-facing behavioral instruction to a terminal deny reason.
 * Instruction first ("what to do — why"): the host's agent-side render
 * already fronts its own attribution sentence, and the teaching reason
 * alone says WHAT was dangerous but not what to do about it. Two
 * variants, because the correct move differs: content denies must not be
 * retried or rephrased; machinery denies were never judged and may be
 * retried later.
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
  return reason ? `${instruction} — ${reason}` : instruction;
}

/**
 * Defensive ceiling for model reasons in notify copies. The prompt
 * anchors reasons at ~150 characters (a concise sentence); the ceiling is
 * the hard display bound when a model runs long — 200 keeps the head+tail
 * view readable while preserving the conclusion and the evidence tail.
 * The audit record keeps the full text regardless.
 */
export const NOTIFY_REASON_CEILING = 200;

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
  // No structural colons: this line can render under the TUI's own
  // "Warning:" prefix at warning level — "Warning: [ai-guard] … risk: x"
  // would double up. Parens carry the detail colon-free.
  //
  // The reason goes out whole — the operator must be able to read (and for
  // a clarification, answer) the model's full text; only a pathological
  // ramble hits the ceiling. The audit record keeps the full text either way.
  //
  // Multi-part construction: segments carry no leading spaces — the join
  // owns the separator, so an absent segment can never leave a gap.
  return [
    `reviewer denied this request`,
    riskLevel ? `(risk ${riskLevel})` : undefined,
    reason ? `— ${truncateMiddle(reason, NOTIFY_REASON_CEILING)}` : undefined,
    // The tail appears only when the outcome diverges from the fact
    // sentence: "denied this request" needs no "— denied" echo; "asking
    // you instead" corrects the operator's read of the sentence (the
    // request was NOT denied — a dialog is coming).
    outcome === "asked" ? "— asking you instead" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}
