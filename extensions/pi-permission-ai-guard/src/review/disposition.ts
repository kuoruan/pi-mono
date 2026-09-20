/**
 * Disposition: the single release seam for every gate that emits a verdict.
 *
 * Each verdict-bearing gate decides a verdict; releasing it — writing the
 * audit record, sending the operator notice, attaching the agent
 * instruction — used to be hand-copied per gate, so the ritual's interface
 * was as complex as any gate. This module owns both release shapes
 * (the pass-through gates — policy, surface-unmatched — and the breaker's
 * own trip ritual stay outside by design):
 *
 * - `releaseMachineryGate` — the four reviewer-failure gates that never hold a parsed verdict
 *   (no-target, model-unresolved, transcript-error, auth-failed). Owns the machinery lane lookup,
 *   the deny reason (computed ONCE — the audit annotation and the returned verdict share it), the
 *   breaker's recoverable-tier credit, the review-stream record (mapped when the gate denies, plain
 *   when it defers), the forced-defer notice, and the returned verdict.
 * - `releaseVerdictGate` — the two gates that emit a real verdict (cache-hit and fresh model). Owns
 *   the mapping decision's side effects: the fail-open notice state, the operator notice, the
 *   `mapped()` record annotation, and the agent instruction on a returned deny.
 *
 * The pure deciding rules stay where they are (`resolveMapping` /
 * `machineryTarget` in verdict-mode): this module performs, it does not
 * decide. Gates declare verdict + facts; the ritual lives here.
 */

import type { AuthorizerLog, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { DECISION_EVENT, type DecisionRecordEntry, mapped } from "#src/audit/decision-record.ts";
import type { Mode } from "#src/config/config-schema.ts";
import type { RiskLevel } from "#src/model/model-verdict.ts";
import type { NotifyFn } from "#src/review/review-pipeline.ts";

import { type CircuitBreaker } from "./circuit-breaker.ts";
import type { PreCallMachineryKind } from "./machinery-kinds.ts";
import {
  machineryDenyReason,
  machineryDeferNotice,
  machineryTarget,
  type ModelDeferInfo,
  resolveMapping,
  withAgentInstruction,
} from "./verdict-mode.ts";

/**
 * What a verdict release hands back to its gate: the record to write, and
 * the verdict to return. The gate writes the record to its own stream
 * (review vs debug) — the stream choice is the gate's one remaining fact.
 */
export interface VerdictRelease {
  /** The annotated (or plain) decision record. */
  record: DecisionRecordEntry;
  /** The verdict the gate emits. */
  verdict: AuthorizerVerdict;
}

/**
 * Release a pre-call machinery gate: the single disposal seam for the
 * four reviewer-failure gates that never hold a parsed verdict (no-target,
 * model-unresolved, transcript-error, auth-failed).
 *
 * The shared invariants — a broken reviewer never rubber-stamps, every
 * reviewer-relevant gate writes the review stream — live here instead of
 * being hand-copied per gate.
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
export function releaseMachineryGate(
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
 * The per-call release context a verdict gate hands the disposition
 * module: the effective mode, the once-per-pipeline fail-open notice
 * state, and the pipeline's notify. The notice state is READ as an input
 * and returned as a mutation signal — the module never owns pipeline
 * lifetime.
 */
export interface VerdictReleaseContext {
  /** The effective mode (the mapping's policy input). */
  mode: Mode;
  /** Whether the once-per-pipeline fail-open notice already fired. */
  noticeShown: boolean;
  /** The pipeline's notify (every notice the mapping owes). */
  notify: NotifyFn;
}

/**
 * A verdict release that may consume the once-per-pipeline fail-open
 * notice state: the caller flips its `shown` flag when `markNoticeShown`.
 */
export interface MarkedVerdictRelease extends VerdictRelease {
  /** Whether this release consumes the once-per-pipeline fail-open notice state. */
  markNoticeShown: boolean;
}

/**
 * Release a verdict-bearing gate (cache-hit or fresh model): resolve the
 * mode mapping, perform its side effects, and hand back the record to
 * write plus the verdict to return.
 *
 * The mapping's shared footwork for the two gates that emit a real
 * verdict: resolveMapping owns the deciding rule (annotation input +
 * every notify owed + the instruction source); this function performs the
 * side effects — flip the notice state, send the notify, annotate the
 * record. The per-call constants (mode, notice state, notify) arrive as
 * the release context — only the per-verdict facts travel as parameters.
 *
 * @param ctx - The per-call release context (mode, notice state, notify).
 * @param record - The gate's decision record (un-annotated).
 * @param original - The reviewer's verdict (model or cached).
 * @param emitted - The verdict the mode mapping emitted.
 * @param riskLevel - The model's risk assessment, if any.
 * @param defer - The fresh review's defer context (undefined on the
 *   cache-hit path — defers are never stored — and when the original is
 *   not a defer).
 * @returns The record to write, the verdict to return (a returned deny
 *   carries the agent instruction; the record keeps the un-instructed
 *   teaching reason), and the fail-open notice signal (see
 *   {@link MarkedVerdictRelease}).
 */
export function releaseVerdictGate(
  ctx: VerdictReleaseContext,
  record: DecisionRecordEntry,
  original: AuthorizerVerdict,
  emitted: AuthorizerVerdict,
  riskLevel: RiskLevel | undefined,
  defer: ModelDeferInfo | undefined,
): MarkedVerdictRelease {
  const decision = resolveMapping({
    original,
    emitted,
    riskLevel,
    deferKind: defer?.kind,
    deferReason: defer?.reason,
    deferLean: defer?.lean,
    mode: ctx.mode,
    noticeShown: ctx.noticeShown,
  });
  if (decision.notice) ctx.notify(decision.notice.message, decision.notice.level);
  const released: VerdictRelease = {
    record: decision.annotate
      ? mapped(record, ctx.mode, emitted.kind, decision.emittedReason)
      : record,
    verdict:
      emitted.kind === "deny"
        ? {
            kind: "deny",
            reason: withAgentInstruction(emitted.reason, decision.instructionSource ?? "content"),
          }
        : emitted,
  };
  return { ...released, markNoticeShown: decision.markNoticeShown };
}
