import { describe, expect, it } from "vitest";

import { DANGER_NONE } from "#src/review/engines/classifier/questions.ts";
import {
  IncompleteClassifierResponseError,
  projectClassifierAnswers,
  riskLevelFromScore,
  synthesizeClassifierVerdict,
} from "#src/review/engines/classifier/verdict.ts";
import type {
  ClassifierAnswers,
  ClassifierThresholds,
} from "#src/review/engines/classifier/verdict.ts";

const THRESHOLDS: ClassifierThresholds = {
  intentThreshold: 0.5,
  riskThreshold: 0.5,
  confidenceThreshold: 0.6,
};

function confident(overrides: Partial<ClassifierAnswers> = {}): ClassifierAnswers {
  return {
    dangerCategory: DANGER_NONE,
    dangerConfidence: 0.95,
    intentMatch: 0.9,
    riskScore: 0.1,
    riskConfidence: 0.9,
    ...overrides,
  };
}

describe("synthesizeClassifierVerdict", () => {
  it("allows when intent matches and risk is low, all confident", () => {
    const out = synthesizeClassifierVerdict(confident(), THRESHOLDS, 100);
    expect(out.verdict).toEqual({ kind: "allow" });
    expect(out.latencyMs).toBe(100);
  });

  it("denies with the category reason on a confident danger hit", () => {
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "credential_exfiltration" }),
      THRESHOLDS,
      42,
    );
    expect(out.verdict).toEqual({
      kind: "deny",
      reason: "matched a safety rule: credential exfiltration",
    });
    // Unknown categories fail safe to high.
    expect(out.riskLevel).toBe("high");
  });

  it("denies a danger hit even when its confidence is below the floor", () => {
    // A danger hit must never defer: a defer with deny-lean maps to allow
    // in permissive mode (fail-open). Deny regardless of confidence.
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "credential_exfiltration", dangerConfidence: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({
      kind: "deny",
      reason: "matched a safety rule: credential exfiltration",
    });
    expect(out.riskLevel).toBe("high");
  });

  it("defers below the floor when no danger hit is present", () => {
    const out = synthesizeClassifierVerdict(confident({ dangerConfidence: 0.3 }), THRESHOLDS, 7);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.deferReason).toBeDefined();
  });

  it("denies a confident danger hit regardless of check order", () => {
    const out = synthesizeClassifierVerdict(
      confident({ dangerCategory: "system_tampering", dangerConfidence: 0.99 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({
      kind: "deny",
      reason: "matched a safety rule: system tampering",
    });
  });

  it("defers neutral when low confidence but no danger signal", () => {
    const out = synthesizeClassifierVerdict(
      confident({ riskConfidence: 0.1, intentMatch: 0.9 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.lean).toBeUndefined();
  });

  it("labels the deny by quartile bands: 0.6 high, 0.8 critical", () => {
    // riskLevel is a fixed rubric reading, independent of riskThreshold:
    // 0.5–0.75 reads high, 0.75+ reads critical. Tier follows the label
    // through denyTier, so both block in every mode at the default 0.5.
    const high = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.6 }),
      THRESHOLDS,
      7,
    );
    expect(high.verdict.kind).toBe("deny");
    expect(high.riskLevel).toBe("high");
    const critical = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.8 }),
      THRESHOLDS,
      7,
    );
    expect(critical.verdict.kind).toBe("deny");
    expect(critical.riskLevel).toBe("critical");
  });

  it("denies at the risk bar even when intent is established", () => {
    // The risk half of the allow gate: high intent must not cross the deny line.
    const out = synthesizeClassifierVerdict(confident({ riskScore: 0.6 }), THRESHOLDS, 7);
    expect(out.verdict.kind).toBe("deny");
  });

  it("cuts the risk bar at 0.5: 0.4 allows, 0.5 denies", () => {
    expect(
      synthesizeClassifierVerdict(confident({ riskScore: 0.4 }), THRESHOLDS, 7).verdict,
    ).toEqual({
      kind: "allow",
    });
    expect(
      synthesizeClassifierVerdict(confident({ riskScore: 0.5 }), THRESHOLDS, 7).verdict.kind,
    ).toBe("deny");
  });

  it("follows a raised risk line: 0.6 allows under a 0.7 line", () => {
    const raised = { ...THRESHOLDS, riskThreshold: 0.7 };
    expect(synthesizeClassifierVerdict(confident({ riskScore: 0.6 }), raised, 7).verdict).toEqual({
      kind: "allow",
    });
  });

  it("defers with an allow lean when intent falls short and risk is low", () => {
    // Matrix #7: the screen is clean, only the authorization link is
    // unclear — lenient allows, default asks.
    const out = synthesizeClassifierVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.deferReason).toBeDefined();
    expect(out.lean).toBe("allow");
  });

  it("defers with a deny lean when confidence is low but risk is over the line", () => {
    // Matrix #5: evidence of danger never leans allow — lenient asks.
    const out = synthesizeClassifierVerdict(
      {
        dangerCategory: DANGER_NONE,
        dangerConfidence: 0.9,
        intentMatch: 0.9,
        riskScore: 0.8,
        riskConfidence: 0.2,
      },
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBe("deny");
  });

  it("defers neutral when confidence is low and risk is under the line", () => {
    // Matrix #6: an untrusted reading has no direction — lenient allows
    // with a fail-open notice, default asks.
    const out = synthesizeClassifierVerdict(
      {
        dangerCategory: DANGER_NONE,
        dangerConfidence: 0.2,
        intentMatch: 0.9,
        riskScore: 0.3,
        riskConfidence: 0.9,
      },
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBeUndefined();
  });

  it("defers neutral on a low-confidence intent gap — untrusted readings lean nothing", () => {
    // Low intent alone does not lean allow when the readings are
    // untrusted: lenient allows with a fail-open notice, not silently.
    const out = synthesizeClassifierVerdict(
      {
        dangerCategory: DANGER_NONE,
        dangerConfidence: 0.2,
        intentMatch: 0.2,
        riskScore: 0.3,
        riskConfidence: 0.9,
      },
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBeUndefined();
  });

  it("defers when the risk confidence is under the floor", () => {
    const out = synthesizeClassifierVerdict(confident({ riskConfidence: 0.2 }), THRESHOLDS, 7);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferReason).toBeDefined();
  });
});

describe("projectClassifierAnswers", () => {
  it("normalizes the 0–4 risk score to the 0–1 verdict scale", () => {
    const answers = projectClassifierAnswers({
      danger_category: { type: "choice", choice: "none", confidence: 0.9 },
      intent_match: { type: "noul", noul: 0.2 },
      risk: { type: "score", score: 3, confidence: 0.9 },
    });
    expect(answers.riskScore).toBe(0.75);
    // Raw 3 reads critical on the quartile bands.
    const out = synthesizeClassifierVerdict(answers, THRESHOLDS, 1);
    expect(out.verdict.kind).toBe("deny");
    expect(out.riskLevel).toBe("critical");
  });

  it("maps quartile bands independent of the threshold", () => {
    expect(riskLevelFromScore(0)).toBe("low");
    expect(riskLevelFromScore(0.24)).toBe("low");
    expect(riskLevelFromScore(0.25)).toBe("medium");
    expect(riskLevelFromScore(0.49)).toBe("medium");
    expect(riskLevelFromScore(0.5)).toBe("high");
    expect(riskLevelFromScore(0.74)).toBe("high");
    expect(riskLevelFromScore(0.75)).toBe("critical");
    expect(riskLevelFromScore(1)).toBe("critical");
  });

  it("throws on missing readings — never answered is malformed, not zero", () => {
    expect(() => projectClassifierAnswers({})).toThrow(IncompleteClassifierResponseError);
    expect(() =>
      projectClassifierAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 0.9 },
        intent_match: { type: "noul", noul: 0.2 },
      }),
    ).toThrow(IncompleteClassifierResponseError);
    expect(() =>
      projectClassifierAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 0.9 },
        intent_match: { type: "noul", noul: 0.2 },
        risk: { type: "score", confidence: 0.9 },
      }),
    ).toThrow(IncompleteClassifierResponseError);
  });

  it("treats missing confidence as zero (uncertain), not malformed", () => {
    const answers = projectClassifierAnswers({
      danger_category: { type: "choice", choice: "none" },
      intent_match: { type: "noul", noul: 0.9 },
      risk: { type: "score", score: 1 },
    });
    expect(answers.dangerConfidence).toBe(0);
    expect(answers.riskConfidence).toBe(0);
    const out = synthesizeClassifierVerdict(answers, THRESHOLDS, 1);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
  });
});
