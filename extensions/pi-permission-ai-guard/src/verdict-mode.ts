/**
 * The mode mapping: how the link disposes the reviewer's non-allow
 * verdicts, and the messages that disposition produces.
 *
 * This module owns the verdict-bearing side of the leniency ladder — the
 * hard/soft deny tiers, the soft-deny/model-defer/machinery lanes'
 * application, the deny reasons, and the human-facing escalation messages.
 * The ladder's operational facts (lanes, cycle membership, emphasis,
 * config warnings) are single-sourced in {@link ./mode-table.ts} and
 * consumed here as data.
 *
 * The doctrine stays local: hard-tier denies (riskLevel high|critical, or
 * missing) are terminal in every mode; reviewer machinery failures never
 * map to allow in ANY mode (a broken reviewer must not rubber-stamp) —
 * they deny under the two extremes and defer under the remaining two;
 * allow is never transformed.
 *
 * Pure functions: the fresh-model path and the cache-hit path both run
 * the mapping, so a cached verdict maps identically to a fresh one.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { Mode } from "./config-schema.ts";
import { MODE_TABLE, type ModeLanes } from "./mode-table.ts";
import type { ModelCallDeferKind, RiskLevel, VerdictLean, VerdictOrigin } from "./model-verdict.ts";
import { truncateMiddle } from "./utils.ts";

/**
 * Extra context for a model defer verdict (fresh-path only — defers are
 * never cached, so the cache-hit path has none of this).
 */
export interface ModelDeferInfo {
  /**
   * Classified defer kind; `model-defer` is the model's own uncertainty, the rest are machinery
   * failures.
   */
  kind?: ModelCallDeferKind;
  /** The clarification request attached to a model defer. */
  reason?: string;
  /**
   * The reviewer's directional inclination on a model defer — which way it
   * would decide if forced. Undefined means neutral. Selects the defer
   * lane; never surfaced to the human (anti-anchoring invariant).
   */
  lean?: VerdictLean;
}

/** A reviewer machinery failure, wherever it happens in the pipeline. */
export type MachineryFailureKind =
  | ModelCallDeferKind
  | "model-unresolved"
  | "auth-failed"
  | "transcript-error"
  | "no-target";

/**
 * The two deny tiers the ladder splits a deny into — hard (terminal in
 * every mode) and soft (mapped by the mode's lanes).
 */
export type DenyTier = "hard" | "soft";

/**
 * Which mapping tier a deny falls into.
 *
 * @param riskLevel - The model's risk assessment for the deny.
 * @returns `"hard"` for high|critical or a missing risk level (absence of
 *   signal must not buy leniency), `"soft"` for low|medium.
 */
export function denyTier(riskLevel: RiskLevel | undefined): DenyTier {
  return riskLevel === undefined || riskLevel === "high" || riskLevel === "critical"
    ? "hard"
    : "soft";
}

/**
 * The machinery lane's target for a mode: deny under the two extremes
 * (`strict` — fail closed by doctrine; `permissive` — a broken reviewer
 * must not rubber-stamp), defer otherwise. Exported for the pipeline's
 * pre-call gates (no-target, model-unresolved, auth-failed,
 * transcript-error), which never hold a parsed verdict.
 *
 * @param mode - The effective mode.
 * @returns The lane's verdict kind (never allow).
 */
export function machineryTarget(mode: Mode): ModeLanes["machinery"] {
  return lanes(mode).machinery;
}

/**
 * Audit marker for a model defer the mode mapped to allow: the reviewer's
 * clarification request never reached the agent. Persisted as the decision
 * record's emittedReason so readers of the review log see what was
 * swallowed.
 */
export const CLARIFICATION_SUPPRESSED_REASON = "clarification-suppressed";

/**
 * Apply the configured mode to a model verdict.
 *
 * @param policy - The effective mode.
 * @param verdict - The model's (or cached) verdict.
 * @param modelDefer - Deferred-call context when the verdict is a fresh model defer.
 * @param riskLevel - The model's risk assessment for a deny verdict.
 * @returns The verdict the link emits.
 */
export function applyVerdictMode(
  policy: Mode,
  verdict: AuthorizerVerdict,
  modelDefer?: ModelDeferInfo,
  riskLevel?: RiskLevel,
): AuthorizerVerdict {
  if (verdict.kind === "allow") {
    return verdict;
  }
  if (verdict.kind === "deny") {
    // Hard-tier denies are terminal in every mode — the reviewer's hard
    // stops are the one judgment the ladder never loosens.
    if (denyTier(riskLevel) === "hard") {
      return verdict;
    }
    return mapLane(lanes(policy).softDeny, verdict, "deny", undefined, policy);
  }
  // Defer: the lane depends on WHO deferred and, for the model's own
  // uncertainty, which way it leans — machinery failures never map to
  // allow, and the model's defer lane splits by lean (benign-leaned
  // doubts pass in the middle modes, danger-leaned ones ask everywhere
  // below strict).
  if (modelDefer?.kind !== "model-defer") {
    return mapLane(lanes(policy).machinery, verdict, "defer", modelDefer, policy);
  }
  const lane =
    modelDefer.lean === "allow"
      ? lanes(policy).deferLeanAllow
      : modelDefer.lean === "deny"
        ? lanes(policy).deferLeanDeny
        : lanes(policy).deferNeutral;
  return mapLane(lane, verdict, "defer", modelDefer, policy);
}

/**
 * The mode's ladder lanes — the single-sourced table, projected.
 *
 * @param mode - The effective mode.
 * @returns The mode's lanes.
 */
function lanes(mode: Mode): ModeLanes {
  return MODE_TABLE[mode].lanes;
}

/**
 * Emit the mapped verdict for one lane of the ladder table, keyed on the
 * verdict's ORIGIN — deny origins map by tier (caller-side), defer origins
 * map by defer lane (the model's uncertainty vs machinery failure).
 *
 * @param target - The lane's verdict kind.
 * @param verdict - The original verdict.
 * @param origin - The original verdict's kind (deny or defer).
 * @param modelDefer - Defer context for reason extraction on deny targets.
 * @param policy - The effective mode (names the policy in deny reasons).
 * @returns The emitted verdict.
 */
function mapLane(
  target: AuthorizerVerdict["kind"],
  verdict: AuthorizerVerdict,
  origin: VerdictOrigin,
  modelDefer: ModelDeferInfo | undefined,
  policy: Mode,
): AuthorizerVerdict {
  if (target === "allow") {
    return { kind: "allow" };
  }
  if (origin === "defer") {
    // Defer origin: defer passes through as-is; deny synthesizes a
    // teaching reason (the clarification request for the reviewer's own
    // uncertainty, the classified failure for machinery).
    if (target === "defer") {
      return verdict;
    }
    return {
      kind: "deny",
      reason:
        modelDefer?.kind === "model-defer"
          ? (modelDefer.reason ?? uncertainDenyReason(policy))
          : machineryDenyReason(modelDefer?.kind, policy),
    };
  }
  // Deny origin: deny passes through with its reason; defer drops the
  // reason — the escalation message re-surfaces it at the human.
  if (target === "deny") {
    return verdict;
  }
  return { kind: "defer" };
}

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
export type EscalationOutcome = "denied" | "asked";

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

/**
 * What the pipeline owes after the mode maps a verdict: the decision
 * record's annotation input and the operator notice. Pure — the
 * once-per-pipeline fail-open notice state is READ as an input and
 * returned as a {@link MappingDecision.markNoticeShown} signal; the
 * caller performs the mutation.
 */
export interface MappingDecision {
  /**
   * The `emittedReason` for the decision record's mapping annotation:
   * deny→allow keeps the swallowed deny reason; defer→allow marks the
   * swallowed clarification; →deny records the synthesized teaching
   * reason the agent DID get (never a "suppressed" marker — nothing was
   * suppressed on the way to a deny). Undefined when the mapping
   * introduced none.
   */
  emittedReason?: string;
  /**
   * Whether the emitted kind differs from the original — the record
   * needs the `mapped()` annotation ({@link DecisionRecord.mapped}).
   */
  annotate: boolean;
  /**
   * The operator notice this mapping owes, rendered and leveled; null
   * when silent. Three kinds: a model deny that HOLDS or escalates
   * (v27 renders no dialog for denials — the notify line is the
   * operator's only copy), a mapped defer (the "asking you instead"
   * tail corrects the operator's read), and the once-per-pipeline
   * fail-open notice (the mode auto-approving against the model's
   * explicit verdict or its neutral uncertainty).
   */
  notice: { message: string; level: "warning" } | null;
  /**
   * Whether this decision consumes the once-per-pipeline fail-open
   * notice state (the caller flips its `shown` flag).
   */
  markNoticeShown: boolean;
}

/**
 * The mapping's consequence resolver — the deciding rule that used to
 * live in the pipeline's closure, extracted as one pure function: given
 * the original verdict, the emitted verdict, and the per-ask context
 * (risk level, defer lean, mode, notice state), it decides the record
 * annotation and every notify the mapping owes. The pipeline calls it
 * and performs the side effects; the rule itself is testable in one
 * place.
 *
 * The input is an object because `original` and `emitted` are adjacent
 * same-typed parameters — positional calls could swap them silently; the
 * lean:allow exemption note (a benign-leaned pass rides the model's own
 * inclination — silent; the fail-open notice belongs to the mode going
 * AGAINST the model) lives in the field docs above.
 *
 * @param input - The per-ask mapping context (verdicts, risk, lean, mode,
 *   notice state), field-documented above.
 * @returns The record-annotation and notify decision.
 */
export function resolveMapping(input: {
  /** The model's (or cached) verdict. */
  original: AuthorizerVerdict;
  /** The verdict the mode mapping emitted. */
  emitted: AuthorizerVerdict;
  /** The model's risk assessment (escalation copy). */
  riskLevel: RiskLevel | undefined;
  /** The reviewer's lean on a fresh model defer. */
  deferLean: VerdictLean | undefined;
  /** The effective mode (names the policy in the fail-open copy). */
  mode: Mode;
  /** Whether the once-per-pipeline fail-open notice already fired. */
  noticeShown: boolean;
}): MappingDecision {
  const { original, emitted, riskLevel, deferLean, mode, noticeShown } = input;
  if (emitted.kind === original.kind) {
    // The verdict held. A model deny that holds in every mode is the
    // reviewer's hardest call — v27 has no dialog for denials (the
    // reason goes to the agent and the audit log alone), so the notify
    // line is the only human-visible copy. Every mode notifies a deny
    // that carries a model reason, regardless of tier. The reason check
    // is doctrine, not live defense: the parser synthesizes
    // GENERIC_DENY_REASON for a reason-less deny, so today this never
    // evaluates false — but the contract is "deny WITH a reason", and a
    // future deny producer (e.g. a persisted cache) could reach here
    // without one.
    return original.kind === "deny" && original.reason
      ? {
          annotate: false,
          notice: { message: escalationMessage(original, riskLevel, "denied"), level: "warning" },
          markNoticeShown: false,
        }
      : { annotate: false, notice: null, markNoticeShown: false };
  }
  // The mapping changed the emitted kind: the record gets the mapping
  // annotation, and the emittedReason tells audit readers what the agent
  // actually received.
  const emittedReason =
    emitted.kind === "allow"
      ? original.kind === "defer"
        ? CLARIFICATION_SUPPRESSED_REASON
        : original.kind === "deny"
          ? original.reason
          : undefined
      : emitted.kind === "deny"
        ? emitted.reason
        : undefined;
  let notice: MappingDecision["notice"] = null;
  let markNoticeShown = false;
  if (emitted.kind === "defer") {
    // A mode-softened deny becomes the human's decision — the tail
    // corrects the operator's read (the request was NOT denied; a dialog
    // is coming).
    notice = { message: escalationMessage(original, riskLevel, "asked"), level: "warning" };
  } else if (emitted.kind === "allow" && deferLean !== "allow" && !noticeShown) {
    // The fail-open notice: the mode passed something against the
    // model's stance — a swallowed deny, or auto-passed NEUTRAL
    // uncertainty. A benign-leaned pass is excluded (the reviewer saying
    // "I would allow this", confirmed — allows never notify). Once per
    // pipeline: the first occurrence teaches, the rest stay quiet.
    markNoticeShown = true;
    const loosened =
      mode === "lenient"
        ? "uncertainty — soft denials still ask"
        : "non-allow verdicts — hard-tier denials still block";
    notice = { message: `${mode} auto-approves ${loosened}`, level: "warning" };
  }
  return { annotate: true, emittedReason, notice, markNoticeShown };
}
