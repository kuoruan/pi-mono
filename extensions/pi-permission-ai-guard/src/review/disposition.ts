/**
 * Disposition: the single release seam for every gate that emits a verdict.
 *
 * Each verdict-bearing gate decides a verdict; releasing it — writing the
 * audit record, sending the operator notice, attaching the agent
 * instruction — lives here, once. One pipeline instance holds one release
 * seam, so the once-per-pipeline fail-open notice state is a private
 * detail of the implementation, not a caller's read-modify-write. This
 * module owns both release shapes (the pass-through gates — policy,
 * surface-unmatched — and the breaker's own trip ritual stay outside by
 * design):
 *
 * - `releaseMachineryGate` — the four reviewer-failure gates that never hold a parsed verdict
 *   (no-target, model-unresolved, transcript-error, auth-failed). Owns the machinery lane lookup,
 *   the deny reason (computed ONCE — the audit annotation and the returned verdict share it), the
 *   breaker's recoverable-tier credit, the forced-defer notice, and the record + verdict to emit.
 * - `releaseVerdictGate` — the two gates that emit a real verdict (cache-hit and fresh model). Owns
 *   the mapping decision's side effects: the fail-open notice state, the operator notice, the
 *   `mapped()` record annotation, and the returned verdict (a deny already carries its agent
 *   instruction — {@link resolveMapping} attaches it).
 *
 * Both methods RETURN their record; the caller emits it, choosing the stream from `record.gate`
 * (see the log-stream doctrine in decision-record.ts). One writer, one place where the "never
 * demote reviewer judgment" rule is enforced.
 *
 * The ladder's deciding rules stay in verdict-rule (`resolveMapping` /
 * `applyVerdictMode`); this module applies their outcome — the machinery lane's
 * consequence (breaker credit, deny copy), the record annotation, the notice,
 * and the agent instruction. Gates declare verdict + facts; the ritual lives
 * here.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { type DecisionRecordEntry, mapped } from "#src/audit/decision-record.ts";
import type { ModePolicy } from "#src/config/mode-policy.ts";
import type { PreCallMachineryKind } from "#src/model/machinery-kinds.ts";
import type { RiskLevel } from "#src/model/model-verdict.ts";
import type { NotifyFn } from "#src/notice.ts";
import { isBoundedDelegationSurface } from "#src/review/request/ask.ts";

import { type CircuitBreaker } from "./circuit-breaker.ts";
import { floorDenyReason, type FloorRuling } from "./deterministic-floor.ts";
import {
  approvalNotice,
  machineryDenyReason,
  machineryDeferNotice,
  type ReviewCost,
  withAgentInstruction,
} from "./verdict-copy.ts";
import { applyVerdictMode, type ModelDeferInfo, resolveMapping } from "./verdict-rule.ts";

/**
 * What a verdict release hands back: the record for the caller to emit
 * (it chooses the stream from `record.gate`), and the verdict to return.
 */
export interface VerdictRelease {
  /** The annotated (or plain) decision record. */
  record: DecisionRecordEntry;
  verdict: AuthorizerVerdict;
}

/**
 * A pre-call machinery gate's facts: the four reviewer-failure gates that
 * never hold a parsed verdict (no-target, model-unresolved,
 * transcript-error, auth-failed).
 */
export interface MachineryGate {
  /** The effective mode policy (the machinery lane's only input). */
  policy: ModePolicy;
  /** The classified machinery failure (pre-call: the review never opened). */
  kind: PreCallMachineryKind;
  /** The gate's decision record (verdict "defer" — the review never opened). */
  record: DecisionRecordEntry;
  /** The session circuit breaker (recoverable-tier credit). */
  breaker: CircuitBreaker;
}

/**
 * A verdict-bearing gate's facts: the two gates that emit a real verdict
 * (cache-hit and fresh model).
 */
export interface VerdictGate {
  /** The effective mode policy (the mapping's policy input). */
  policy: ModePolicy;
  /** The gate's decision record (un-annotated). */
  record: DecisionRecordEntry;
  /** The reviewer's verdict (model or cached). */
  original: AuthorizerVerdict;
  emitted: AuthorizerVerdict;
  riskLevel: RiskLevel | undefined;
  /**
   * The fresh review's defer context (undefined on the cache-hit path —
   * defers are never stored — and when the original is not a defer).
   */
  defer: ModelDeferInfo | undefined;
  /** The review's cost for the approval tail (fresh latency or cached replay). */
  cost: ReviewCost;
  /** The floor's hit and ruling, when a floored allow changed the verdict. */
  floor?: FloorRuling | null;
}

/**
 * The release seam's per-pipeline configuration: the notify it sends every
 * notice through, and whether emitted allows are announced.
 */
export interface DispositionDeps {
  notify: NotifyFn;
  /** Whether to announce emitted allows; ambient notifyLevel still applies. */
  notifyApprovals: boolean;
}

/** The release seam for one pipeline instance. */
export interface Disposition {
  /**
   * Release a pre-call machinery gate. The shared invariants — a broken
   * reviewer never rubber-stamps, every reviewer-relevant gate emits its
   * record — live behind this method.
   *
   * @param gate - The machinery gate's facts.
   * @returns The record to emit and the verdict the gate returns.
   */
  releaseMachineryGate(gate: MachineryGate): VerdictRelease;
  /**
   * Release a verdict-bearing gate.
   *
   * @param gate - The verdict gate's facts.
   * @returns The record to emit and the verdict to return.
   */
  releaseVerdictGate(gate: VerdictGate): VerdictRelease;
}

/**
 * Create the release seam for one pipeline instance. The fail-open notice
 * state fires on the first mapped allow, then stays silent.
 *
 * @param deps - The per-pipeline notify and approval flag.
 * @returns The release seam.
 */
export function createDisposition(deps: DispositionDeps): Disposition {
  let noticeShown = false;

  return {
    releaseMachineryGate({ policy, kind, record, breaker }) {
      const mode = policy.mode;
      // The pre-call gate never holds a parsed verdict, so it maps a bare
      // defer with no model-defer context: `applyVerdictMode` takes the
      // machinery lane, the ladder's single execution site for this axis.
      const mappedVerdict = applyVerdictMode(policy, { kind: "defer" });
      if (mappedVerdict.kind !== "deny") {
        // Forced defer interrupts the human with no dialog context of its
        // own — same doctrine as the breaker trip: name the cause.
        deps.notify(machineryDeferNotice(kind), "warning");
        return { record, verdict: { kind: "defer" } };
      }
      breaker.recordDenyEquivalent();
      const reason = machineryDenyReason(kind, mode);
      // The audit annotation keeps the un-instructed reason; the returned
      // verdict carries the agent instruction (a machinery denial was never
      // judged — retrying later is legitimate).
      return {
        record: mapped(record, mode, "deny", reason),
        verdict: { kind: "deny", reason: withAgentInstruction(reason, "machinery") },
      };
    },

    releaseVerdictGate({ policy, record, original, emitted, riskLevel, defer, cost, floor }) {
      const mode = policy.mode;
      if (floor !== null && floor !== undefined) {
        // A reviewer allow that met proven-irreversible facts, and the mode's
        // ruling on it. The verdict is the link's own, so the mapping never
        // runs: its "reviewer denied" copy would misreport an allow as a
        // denial, and its allow-side approval notice must not announce an
        // action we are about to ask about (or have just blocked).
        const reason = floor.hit.reason;
        if (floor.ruling === "deny") {
          // Operator policy, not reviewer judgment: no ambient notice (the
          // agent gets the instruction, and the record names the ruling).
          return {
            record: mapped(record, mode, "deny", floorDenyReason(floor.hit)),
            verdict: {
              kind: "deny",
              reason: withAgentInstruction(floorDenyReason(floor.hit), "content"),
            },
          };
        }
        // An ask: a warning like every other forced ask (machinery and breaker
        // defers, mode-softened denies) — a dialog is coming, and a rank-gated
        // ambient feed must not stay silent about exactly the ask that closes
        // the silent-pass invariant.
        deps.notify(reason, "warning");
        return {
          record: mapped(record, mode, "defer", reason),
          verdict: { kind: "defer" },
        };
      }
      const decision = resolveMapping({
        original,
        emitted,
        riskLevel,
        deferKind: defer?.kind,
        deferReason: defer?.reason,
        deferLean: defer?.lean,
        mode,
        noticeShown,
      });
      if (decision.notice) deps.notify(decision.notice.message, decision.notice.level);
      // Only this gate emits reviewer-backed allows (fresh or cached). The host
      // caps path/external-directory allows to defer, so those are not approvals.
      // Never echo the target: commands may contain secrets or control text.
      if (
        deps.notifyApprovals &&
        emitted.kind === "allow" &&
        record.surface &&
        !isBoundedDelegationSurface(record.surface)
      ) {
        deps.notify(
          approvalNotice(
            original.kind === "allow" ? { kind: "reviewer" } : { kind: "mode", mode },
            cost,
          ),
          "info",
        );
      }
      if (decision.markNoticeShown) noticeShown = true;
      return {
        record: decision.annotate
          ? mapped(record, mode, emitted.kind, decision.emittedReason)
          : record,
        verdict: decision.verdict,
      };
    },
  };
}
