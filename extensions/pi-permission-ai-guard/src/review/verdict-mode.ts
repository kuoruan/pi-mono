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

import type { Mode } from "#src/config/config-schema.ts";
import { MODE_TABLE, type ModeLanes } from "#src/config/mode-table.ts";
import type {
  ModelCallDeferKind,
  RiskLevel,
  VerdictLean,
  VerdictOrigin,
} from "#src/model/model-verdict.ts";
import { truncateMiddle } from "#src/utils.ts";

import type { MachineryFailureKind } from "./machinery-kinds.ts";

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

/** The behavioral instruction for a content deny (the request was judged). */
const CONTENT_DENY_INSTRUCTION =
  "Automatic review denied this, not the user. Do not rephrase, retry, or work around it; if the user wants it, they should ask explicitly.";

/** The behavioral instruction for a machinery deny (the review failed). */
const MACHINERY_DENY_INSTRUCTION =
  "Automatic review failed (the reviewer, not the request). Retry later, or ask the user to request it explicitly if urgent.";

/**
 * Append the agent-facing behavioral instruction to a terminal deny reason.
 *
 * A deny that terminates the chain is the last word the agent hears; the
 * teaching reason alone says WHAT was dangerous but not what to do about
 * it. The instruction names the denier (not a human click — the agent must
 * not attribute the refusal to the user and argue around it) and the
 * legitimate path (stop pursuing / retry later, user re-requests
 * explicitly). Two variants, because the agent's correct move differs:
 * content denies must not be retried or rephrased; machinery denies were
 * never judged and may legitimately be retried later.
 *
 * Applies ONLY to the returned verdict's reason — the audit record's
 * `emittedReason` and the operator notify lines keep the un-instructed
 * mapping reason (the instruction is agent-channel copy, not an audit
 * fact, and a line addressed to the agent would read as noise to the
 * operator).
 *
 * @param reason - The mapped deny reason (the teaching reason), or
 *   undefined when the deny carries none (the instruction still stands
 *   alone — the agent needs the behavioral guidance regardless).
 * @param source - Which kind of deny produced the reason.
 * @returns The reason with the instruction appended (or the instruction
 *   alone when no reason was present).
 */
export function withAgentInstruction(
  reason: string | undefined,
  source: DenyInstructionSource,
): string {
  const instruction =
    source === "machinery" ? MACHINERY_DENY_INSTRUCTION : CONTENT_DENY_INSTRUCTION;
  return reason ? `${reason} — ${instruction}` : instruction;
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
   * The operator notice this disposition owes, rendered and leveled; null
   * when silent. Five kinds: a model deny that HOLDS or escalates
   * (v27 renders no dialog for denials — the notify line is the
   * operator's only copy), a mapped defer (the "asking you instead"
   * tail corrects the operator's read), the once-per-pipeline fail-open
   * notice (the mode auto-approving against the model's explicit verdict
   * or its neutral uncertainty), a model-defer that emitted as defer
   * (the "reviewer asks" mirror — the dialog alone never shows what the
   * reviewer wants clarified), and a machinery defer that emitted as
   * defer (the cause notice — a forced defer must name its failure kind).
   */
  notice: { message: string; level: "info" | "warning" } | null;
  /**
   * The agent instruction's source for an emitted deny — the
   * discrimination rule (machinery iff the original was a machinery
   * defer) lives here, once; null when nothing deny-shaped was emitted.
   */
  instructionSource: DenyInstructionSource | null;
  /**
   * Whether this decision consumes the once-per-pipeline fail-open
   * notice state (the caller flips its `shown` flag).
   */
  markNoticeShown: boolean;
}

/**
 * The per-ask mapping context resolveMapping decides on: the verdicts
 * (original vs emitted), the risk/defer classification, the lean, the
 * mode, and the once-per-pipeline notice state.
 */
export interface MappingInput {
  /** The model's (or cached) verdict. */
  original: AuthorizerVerdict;
  /** The verdict the mode mapping emitted. */
  emitted: AuthorizerVerdict;
  /** The model's risk assessment (escalation copy). */
  riskLevel: RiskLevel | undefined;
  /**
   * The fresh review's defer classification (kind + clarification
   * request) when the original is a defer; undefined on the cache-hit
   * path (defers are never stored — a cached original is allow/deny
   * only) and when the original is not a defer.
   */
  deferKind: ModelCallDeferKind | undefined;
  /** The model's clarification request on its own defer, if any. */
  deferReason: string | undefined;
  /** The reviewer's lean on a fresh model defer. */
  deferLean: VerdictLean | undefined;
  /** The effective mode (names the policy in the fail-open copy). */
  mode: Mode;
  /** Whether the once-per-pipeline fail-open notice already fired. */
  noticeShown: boolean;
}

/**
 * The mapping's consequence resolver — the deciding rule that used to
 * live in the pipeline's closure, extracted as one pure function: given
 * the original verdict, the emitted verdict, and the per-ask context
 * (risk level, defer classification, lean, mode, notice state), it
 * decides the record annotation, every notify the disposition owes, and
 * the agent instruction's source. The pipeline calls it and performs
 * the side effects; the rule itself is testable in one place.
 *
 * The input is an object because `original` and `emitted` are adjacent
 * same-typed parameters — positional calls could swap them silently; the
 * lean:allow exemption note (a benign-leaned pass rides the model's own
 * inclination — silent; the fail-open notice belongs to the mode going
 * AGAINST the model) lives in the field docs above.
 *
 * @param input - The per-ask mapping context, field-documented on
 *   {@link MappingInput}.
 * @returns The record-annotation, notify, and instruction-source decision.
 */
export function resolveMapping(input: MappingInput): MappingDecision {
  const { original, emitted, riskLevel, deferKind, deferReason, deferLean, mode, noticeShown } =
    input;
  // The agent instruction's source: machinery iff what was denied is a
  // machinery defer (the review failed — retry-later copy); content
  // otherwise (the request itself was judged — stop-pursuing copy). Null
  // when nothing deny-shaped was emitted. One rule, stated once: the
  // cache-hit path derives "content" from it structurally (a cached
  // original is allow/deny only, so the machinery branch is unreachable
  // by type, not by comment).
  const instructionSource: DenyInstructionSource | null =
    emitted.kind === "deny"
      ? original.kind === "defer" && deferKind !== undefined && deferKind !== "model-defer"
        ? "machinery"
        : "content"
      : null;
  // A defer that emitted as defer owes its own notices: the model's
  // clarification (mirrored — the upstream defer verdict carries no
  // reason field, so the dialog alone would never show WHAT the reviewer
  // wants clarified), or the machinery cause (a forced defer must name
  // its failure kind — same doctrine as the pre-call gates). A terse
  // model defer without a reason stays silent (the verdict itself
  // completed; parseVerdictObject documents the omission).
  const deferNotice: { message: string; level: "info" | "warning" } | null =
    emitted.kind === "defer" && original.kind === "defer"
      ? deferKind === "model-defer" && deferReason
        ? {
            message: `reviewer asks — ${truncateMiddle(deferReason, NOTIFY_REASON_CEILING)}`,
            level: "info",
          }
        : deferKind !== undefined && deferKind !== "model-defer"
          ? { message: machineryDeferNotice(deferKind), level: "warning" }
          : null
      : null;
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
    // without one. A defer that holds still owes its own notice (the
    // machinery cause, or the model's mirrored clarification).
    if (original.kind === "deny" && original.reason) {
      return {
        annotate: false,
        notice: { message: escalationMessage(original, riskLevel, "denied"), level: "warning" },
        instructionSource,
        markNoticeShown: false,
      };
    }
    return {
      annotate: false,
      notice: deferNotice,
      instructionSource,
      markNoticeShown: false,
    };
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
  let notice: MappingDecision["notice"] = deferNotice;
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
  return { annotate: true, emittedReason, notice, instructionSource, markNoticeShown };
}
