/**
 * The mode: who adjudicates the model's non-allow verdicts.
 *
 * This module owns the mapping from what the model (or the cache) said to
 * what the link emits, the deny reasons that mapping produces, and the
 * human-facing messages for the interruptions the mapping causes — one
 * place for the whole semantic, one test file for its table.
 *
 * `manual` maps every deny to a defer — the human adjudicates (and can
 * override) everything the model doesn't allow. `auto` is fully
 * automatic and fail-closed: EVERYTHING that would otherwise fall to the
 * human is denied — the model's own uncertainty (`model-defer`) uses the
 * defer's clarification request as the deny's teaching reason, and
 * reviewer machinery failures (timeout, call-failed, empty-reply,
 * no-json, invalid-verdict-value, model-unresolved, auth-failed,
 * transcript-error) deny with the classified failure as the reason.
 * Nothing falls to the user in auto mode. `default` passes both verdict
 * kinds through. Allow is never transformed, and no mapping ever weakens
 * a deny into an allow.
 *
 * Pure functions: the fresh-model path and the cache-hit path both run
 * the mapping, so a cached deny maps identically to a fresh one.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { Mode } from "./config-schema.ts";
import { NOTIFY_PREFIX } from "./logger.ts";
import type { ModelCallDeferKind, RiskLevel } from "./verdict.ts";

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
}

/** A reviewer machinery failure, wherever it happens in the pipeline. */
export type MachineryFailureKind =
  | ModelCallDeferKind
  | "model-unresolved"
  | "auth-failed"
  | "transcript-error"
  | "no-target";

/** Reason carried by an auto-policy deny mapped from a defer with no clarification request. */
export const AUTO_DEFER_DENY_REASON = "Reviewer was uncertain; auto mode denies uncertain requests";

/**
 * Apply the configured mode to a model verdict.
 *
 * @param policy - The effective mode.
 * @param verdict - The model's (or cached) verdict.
 * @param modelDefer - Deferred-call context when the verdict is a fresh model defer.
 * @returns The verdict the link emits.
 */
export function applyVerdictMode(
  policy: Mode,
  verdict: AuthorizerVerdict,
  modelDefer?: ModelDeferInfo,
): AuthorizerVerdict {
  if (verdict.kind === "deny") {
    return policy === "manual" ? { kind: "defer" } : verdict;
  }
  if (verdict.kind === "defer") {
    if (policy !== "auto") return verdict;
    return {
      kind: "deny",
      reason:
        modelDefer?.kind === "model-defer"
          ? (modelDefer.reason ?? AUTO_DEFER_DENY_REASON)
          : autoDenyReason(modelDefer?.kind),
    };
  }
  return verdict;
}

/**
 * Surface the reviewer's reasoning when the manual policy hands a model
 * deny to the human — the permission dialog renders only the request, so
 * without this the reviewer's judgment is audit-log-only.
 *
 * @param verdict - The model's verdict (a deny at every call site — the
 *   manual mapping only produces defers from denies).
 * @param riskLevel - The risk level attached to the deny, if any.
 * @returns The notification message.
 */
export function manualEscalationMessage(
  verdict: AuthorizerVerdict,
  riskLevel: RiskLevel | undefined,
): string {
  const reason = verdict.kind === "deny" ? verdict.reason : undefined;
  const risk = riskLevel ? ` (risk: ${riskLevel})` : "";
  const reasonSuffix = reason ? ` — ${reason}` : "";
  return `${NOTIFY_PREFIX} reviewer denied this request${risk}${reasonSuffix}`;
}

/**
 * The deny reason for an auto-policy machinery-failure denial: the agent
 * sees why the review could not complete instead of a silent deny.
 *
 * @param deferKind - The classified failure kind, if any.
 * @returns The deny teaching reason.
 */
export function autoDenyReason(deferKind: MachineryFailureKind | undefined): string {
  return `reviewer could not complete the review (${deferKind ?? "unknown"}) — auto mode denied the request`;
}
