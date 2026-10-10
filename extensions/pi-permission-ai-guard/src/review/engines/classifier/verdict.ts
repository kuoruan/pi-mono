import type { ReviewOutcome, RiskLevel, VerdictLean } from "#src/model/model-verdict.ts";
import { GENERIC_DENY_REASON } from "#src/model/model-verdict.ts";
import { underscoresToWords } from "#src/utils.ts";

import { DANGER_NONE, RISK_RUBRIC } from "./questions.ts";

/**
 * The built-in answers as 0–1 probabilities/confidences: `noul` arrives
 * as a probability already, the 0–4 `score` is normalized by
 * {@link projectClassifierAnswers}, so every answer speaks one scale.
 */
export interface ClassifierAnswers {
  dangerCategory: string;
  dangerConfidence: number;
  intentMatch: number;
  riskScore: number;
  riskConfidence: number;
}

export interface ClassifierThresholds {
  intentThreshold: number;
  riskThreshold: number;
  confidenceThreshold: number;
}

/** One raw SDK answer (the per-question shape the SDK returns). */
interface TypesafeRawAnswer {
  type: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
}

/**
 * Thrown when a System One response is missing a required reading.
 * The adapter's catch routes it to a machinery defer (never allow) —
 * a reviewer that did not answer is broken, not uncertain.
 */
export class IncompleteClassifierResponseError extends Error {
  constructor(public readonly missing: string) {
    super(`incomplete classifier response: missing ${missing}`);
    this.name = "IncompleteClassifierResponseError";
  }
}

/**
 * Project the SDK's typed answers into {@link ClassifierAnswers} — the single
 * 0–4 → 0–1 scale-conversion point.
 *
 * Readings are required: `danger_category` / `intent_match` / `risk` must
 * be present with their reading fields (choice / noul / score). A missing
 * reading throws {@link IncompleteClassifierResponseError} — "never answered"
 * is a malformed response, not a zero reading. Confidence is optional:
 * missing confidence reads as 0 (uncertain), the model's own defer path.
 *
 * @param raw - The SDK's typed answers by question id.
 * @returns The calibrated 0–1 answers.
 */
export function projectClassifierAnswers(
  raw: Record<string, TypesafeRawAnswer>,
): ClassifierAnswers {
  const danger = raw.danger_category;
  if (danger?.choice === undefined) {
    throw new IncompleteClassifierResponseError("danger_category.choice");
  }
  const intent = raw.intent_match;
  if (intent?.noul === undefined) {
    throw new IncompleteClassifierResponseError("intent_match.noul");
  }
  const risk = raw.risk;
  if (risk?.score === undefined) {
    throw new IncompleteClassifierResponseError("risk.score");
  }
  return {
    dangerCategory: danger.choice,
    dangerConfidence: danger.confidence ?? 0,
    intentMatch: intent.noul,
    // The score is the probability-weighted level index, so its range is the
    // rubric's own level count minus one (TypeSafe requires at least two
    // levels). Derive the divisor rather than hard-coding it: a hard-coded 4
    // silently mis-scales every band if the rubric gains or loses a level.
    riskScore: risk.score / (RISK_RUBRIC.length - 1),
    riskConfidence: risk.confidence ?? 0,
  };
}

/**
 * Danger category → audit risk tier. Every DENY-Always deny is critical;
 * unlisted categories fall back to high (an unknown danger is never soft).
 */
const DANGER_TIER: Readonly<Record<string, RiskLevel>> = {
  secrets_credentials: "critical",
  irreversible_destruction: "critical",
  sensitive_data_egress: "critical",
  system_tampering: "critical",
  persistent_system_changes: "critical",
  external_code_execution: "critical",
  destructive_vcs: "critical",
  resource_abuse_dos: "critical",
};

/**
 * Map a normalized risk score (0–1) to its audit tier. Fixed — it does not
 * move with `riskThreshold`, so audit labels stay comparable across configs.
 * The bands are quartiles of the 0–4 rubric's own span, and the rubric's
 * anchors are named for damage, not for tiers — so anchor text and audit tier
 * are separate vocabularies and a log line can never read as contradicting
 * itself:
 *
 * | raw | score band  | tier     | rubric anchor             |
 * | --- | ----------- | -------- | ------------------------- |
 * | 0   | [0, 0.25)   | low      | No damage                 |
 * | 1   | [0.25, 0.5) | medium   | Bounded damage            |
 * | 2   | [0.5, 0.75) | high     | Costly or hard to reverse |
 * | 3   | [0.75, 1)   | critical | Severe                    |
 * | 4   | 1.0         | critical | Catastrophic              |
 *
 * Anchor k lands in band k, so the top band holds the last two anchors — four
 * bands and five anchors cannot line up one-to-one.
 *
 * The band boundaries are load-bearing, not cosmetic: {@link denyTier} makes
 * high|critical hard and low|medium soft, so at the default `riskThreshold`
 * (0.5) a deny starts at the "Costly or hard to reverse" rung — band high, hence
 * hard — and no risk-lane deny can land in the soft tier, where permissive
 * would allow it. Lowering the threshold below 0.5 would put the "Bounded
 * damage" rung at the line, where its medium band softens the deny.
 *
 * @param riskScore - The normalized 0–1 risk score.
 * @returns The audit tier.
 */
export function riskLevelFromScore(riskScore: number): RiskLevel {
  if (riskScore >= 0.75) return "critical";
  if (riskScore >= 0.5) return "high";
  if (riskScore >= 0.25) return "medium";
  return "low";
}

/**
 * The reviewer's directional inclination on an unresolved verdict: which
 * way it would decide if forced. Only the danger direction counts —
 * a risk score at or above the deny line leans deny (evidence of danger
 * never leans allow); a pure intent gap with trusted readings leans
 * allow (the screen is clean, only the authorization link is unclear);
 * anything else is neutral (an untrusted reading has no direction).
 * Never surfaced to the human (anti-anchoring invariant).
 *
 * @param answers - The calibrated answers.
 * @param thresholds - The intent/risk/confidence thresholds.
 * @param confident - Whether both confidences clear the floor (false on
 *   the low-confidence defer branch — an untrusted reading leans nothing).
 * @returns The lean, or undefined for neutral.
 */
function deriveLean(
  answers: ClassifierAnswers,
  thresholds: ClassifierThresholds,
  confident: boolean,
): VerdictLean | undefined {
  if (answers.riskScore >= thresholds.riskThreshold) return "deny";
  if (confident && answers.intentMatch < thresholds.intentThreshold) return "allow";
  return undefined;
}

/**
 * Synthesize a {@link ReviewOutcome} from calibrated answers, top-down:
 * danger hit → deny (before the confidence check — a danger hit must stay
 * decisive, otherwise it would project to a neutral defer the permissive
 * mode auto-allows); below-threshold confidence → defer;
 * intent + risk below the deny line → allow;
 * otherwise the DENY-Unless lane — a risk score at or above the deny line
 * denies, labeled by the fixed quartile bands ({@link riskLevelFromScore}).
 * The tier follows the label through denyTier: at the default threshold
 * (0.5) every risk-lane deny reads high/critical and blocks in every mode;
 * a lower threshold reopens a soften-able low/medium band.
 *
 * @param answers - The calibrated answers.
 * @param thresholds - The intent/risk/confidence thresholds.
 * @param latencyMs - The call latency for the audit record.
 * @returns The synthesized review outcome.
 */
export function synthesizeClassifierVerdict(
  answers: ClassifierAnswers,
  thresholds: ClassifierThresholds,
  latencyMs: number,
): ReviewOutcome {
  if (answers.dangerCategory !== DANGER_NONE) {
    return {
      verdict: {
        kind: "deny",
        reason: `matched a safety rule: ${underscoresToWords(answers.dangerCategory)}`,
      },
      latencyMs,
      riskLevel: DANGER_TIER[answers.dangerCategory] ?? "high",
    };
  }
  const minConfidence = Math.min(answers.dangerConfidence, answers.riskConfidence);
  if (minConfidence < thresholds.confidenceThreshold) {
    return {
      verdict: { kind: "defer" },
      deferKind: "model-defer",
      // The ternary names the reading that fell short; the ask is the same either
      // way, because what the lanes share is the shape, not the words.
      deferReason:
        answers.dangerConfidence <= answers.riskConfidence
          ? "could not tell whether this is dangerous (is it safe to run?)"
          : "could not judge how much damage this could do (is it safe to run?)",
      lean: deriveLean(answers, thresholds, false),
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
      riskLevel: riskLevelFromScore(answers.riskScore),
    };
  }
  // Only intent can still fall short here (risk at or above the line already denied above).
  return {
    verdict: { kind: "defer" },
    deferKind: "model-defer",
    // Deliberately not byte-equal to the chat lane's example: a lane-spanning
    // constant is how one content-free line reached the operator from both engines.
    deferReason: "could not tie this action to your request (did you ask for it?)",
    lean: deriveLean(answers, thresholds, true),
    latencyMs,
  };
}
