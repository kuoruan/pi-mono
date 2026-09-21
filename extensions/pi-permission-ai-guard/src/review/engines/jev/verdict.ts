import type { ReviewOutcome, RiskLevel, VerdictLean } from "#src/model/model-verdict.ts";
import { GENERIC_DENY_REASON } from "#src/model/model-verdict.ts";

import { DANGER_NONE } from "./questions.ts";

/**
 * The built-in answers as 0–1 probabilities/confidences: `noul` arrives
 * as a probability already, the 0–4 `score` is normalized by
 * {@link projectRawAnswers}, so the table below speaks one scale.
 */
export interface JevAnswers {
  dangerCategory: string;
  dangerConfidence: number;
  intentMatch: number;
  riskScore: number;
  riskConfidence: number;
}

export interface JevThresholds {
  intentThreshold: number;
  riskThreshold: number;
  confidenceThreshold: number;
}

/** One raw SDK answer (the per-question shape the SDK returns). */
export interface TypesafeRawAnswer {
  type: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
}

/**
 * Project the SDK's typed answers into {@link JevAnswers} — the single
 * 0–4 → 0–1 scale-conversion point. Missing answers degrade to the safest
 * zero-ish projection (no danger, no match, zero confidence → floor defer).
 *
 * @param raw - The SDK's typed answers by question id.
 * @returns The calibrated 0–1 answers.
 */
export function projectRawAnswers(raw: Record<string, TypesafeRawAnswer>): JevAnswers {
  const danger = raw.danger_category;
  const risk = raw.risk;
  return {
    dangerCategory: danger?.choice ?? DANGER_NONE,
    dangerConfidence: danger?.confidence ?? 0,
    intentMatch: raw.intent_match?.noul ?? 0,
    riskScore: (risk?.score ?? 0) / 4,
    riskConfidence: risk?.confidence ?? 0,
  };
}

/**
 * Danger category → audit risk tier. Every DENY-Always deny is critical;
 * unlisted categories fall back to high (an unknown danger is never soft).
 */
export const DANGER_TIER: Readonly<Record<string, RiskLevel>> = {
  secrets_credentials: "critical",
  irreversible_destruction: "critical",
  sensitive_data_egress: "critical",
  system_tampering: "critical",
  persistent_system_changes: "critical",
  external_code_execution: "critical",
  external_exposure: "critical",
  destructive_vcs: "critical",
  resource_abuse_dos: "critical",
};

/** The answers that carry a calibrated confidence, in report order. */
const KEY_CONFIDENCES = [
  { axis: "danger_category", key: "dangerConfidence" },
  { axis: "risk", key: "riskConfidence" },
] as const;

function deriveLean(answers: JevAnswers, thresholds: JevThresholds): VerdictLean | undefined {
  if (answers.dangerCategory !== DANGER_NONE) return "deny";
  if (answers.intentMatch < thresholds.intentThreshold) return "deny";
  return undefined;
}

/**
 * Synthesize a {@link ReviewOutcome} from calibrated answers, top-down:
 * danger hit → deny (before the confidence check — a danger defer could
 * otherwise lean-allow in permissive mode); below-threshold confidence → defer;
 * intent + risk below the deny line → allow;
 * otherwise the DENY-Unless lane — a risk score at or above the deny bar is a
 * soft deny, anything below it defers.
 *
 * The soft tier is the LANE's, not the rubric's: the DENY-Unless categories
 * are exactly the ones a mode may soften, so even the rubric's top band stays
 * at `medium` (the strongest tier that still softens); only the DENY-Always
 * danger categories reach the hard tier.
 *
 * @param answers - The calibrated answers.
 * @param thresholds - The intent/risk/confidence thresholds.
 * @param latencyMs - The call latency for the audit record.
 * @returns The synthesized review outcome.
 */
export function synthesizeJevVerdict(
  answers: JevAnswers,
  thresholds: JevThresholds,
  latencyMs: number,
): ReviewOutcome {
  if (answers.dangerCategory !== DANGER_NONE) {
    return {
      verdict: { kind: "deny", reason: `matched rule: ${answers.dangerCategory}` },
      latencyMs,
      riskLevel: DANGER_TIER[answers.dangerCategory] ?? "high",
    };
  }
  const weakest = KEY_CONFIDENCES.reduce((a, b) => (answers[a.key] <= answers[b.key] ? a : b));
  const minConfidence = answers[weakest.key];
  if (minConfidence < thresholds.confidenceThreshold) {
    return {
      verdict: { kind: "defer" },
      deferKind: "model-defer",
      deferReason: `unsure about this action (${weakest.axis} confidence ${minConfidence.toFixed(2)} < ${thresholds.confidenceThreshold.toFixed(2)})`,
      lean: deriveLean(answers, thresholds),
      latencyMs,
    };
  }
  // Allow needs both: the anchor authorizes it AND risk stays below the
  // deny line.
  if (
    answers.intentMatch >= thresholds.intentThreshold &&
    answers.riskScore < thresholds.riskThreshold
  ) {
    return { verdict: { kind: "allow" }, latencyMs };
  }
  if (answers.riskScore >= thresholds.riskThreshold) {
    return {
      verdict: { kind: "deny", reason: GENERIC_DENY_REASON },
      latencyMs,
      riskLevel: answers.riskScore >= 0.75 ? "medium" : "low",
    };
  }
  // Only intent can still fall short here (risk at or above the line already denied above).
  return {
    verdict: { kind: "defer" },
    deferKind: "model-defer",
    deferReason: `unsure this matches your request (intent_match ${answers.intentMatch.toFixed(2)} < ${thresholds.intentThreshold.toFixed(2)})`,
    lean: deriveLean(answers, thresholds),
    latencyMs,
  };
}
