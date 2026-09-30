import { describe, expect, it } from "vitest";

import { DANGER_NONE } from "#src/review/engines/jev/questions.ts";
import {
  IncompleteJevResponseError,
  projectRawAnswers,
  riskLevelFromScore,
  synthesizeJevVerdict,
} from "#src/review/engines/jev/verdict.ts";
import type { JevAnswers, JevThresholds } from "#src/review/engines/jev/verdict.ts";

const THRESHOLDS: JevThresholds = {
  intentThreshold: 0.5,
  riskThreshold: 0.5,
  confidenceThreshold: 0.6,
};

function confident(overrides: Partial<JevAnswers> = {}): JevAnswers {
  return {
    dangerCategory: DANGER_NONE,
    dangerConfidence: 0.95,
    intentMatch: 0.9,
    riskScore: 0.1,
    riskConfidence: 0.9,
    ...overrides,
  };
}

describe("synthesizeJevVerdict", () => {
  it("allows when intent matches and risk is low, all confident", () => {
    const out = synthesizeJevVerdict(confident(), THRESHOLDS, 100);
    expect(out.verdict).toEqual({ kind: "allow" });
    expect(out.latencyMs).toBe(100);
  });

  it("denies with the category reason on a confident danger hit", () => {
    const out = synthesizeJevVerdict(
      confident({ dangerCategory: "credential_exfiltration" }),
      THRESHOLDS,
      42,
    );
    expect(out.verdict).toEqual({ kind: "deny", reason: "matched rule: credential_exfiltration" });
    // Unknown categories fail safe to high.
    expect(out.riskLevel).toBe("high");
  });

  it("denies a danger hit even when its confidence is below the floor", () => {
    // A danger hit must never defer: a defer with deny-lean maps to allow
    // in permissive mode (fail-open). Deny regardless of confidence.
    const out = synthesizeJevVerdict(
      confident({ dangerCategory: "credential_exfiltration", dangerConfidence: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "deny", reason: "matched rule: credential_exfiltration" });
    expect(out.riskLevel).toBe("high");
  });

  it("defers below the floor when no danger hit is present", () => {
    const out = synthesizeJevVerdict(confident({ dangerConfidence: 0.3 }), THRESHOLDS, 7);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.deferReason).toContain("danger_category");
    expect(out.deferReason).toContain("unsure about this action");
  });

  it("denies a confident danger hit regardless of check order", () => {
    const out = synthesizeJevVerdict(
      confident({ dangerCategory: "system_tampering", dangerConfidence: 0.99 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "deny", reason: "matched rule: system_tampering" });
  });

  it("defers neutral when low confidence but no danger signal", () => {
    const out = synthesizeJevVerdict(
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
    const high = synthesizeJevVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.6 }),
      THRESHOLDS,
      7,
    );
    expect(high.verdict.kind).toBe("deny");
    expect(high.riskLevel).toBe("high");
    const critical = synthesizeJevVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.8 }),
      THRESHOLDS,
      7,
    );
    expect(critical.verdict.kind).toBe("deny");
    expect(critical.riskLevel).toBe("critical");
  });

  it("denies at the risk bar even when intent is established", () => {
    // The risk half of the allow gate: high intent must not cross the deny line.
    const out = synthesizeJevVerdict(confident({ riskScore: 0.6 }), THRESHOLDS, 7);
    expect(out.verdict.kind).toBe("deny");
  });

  it("cuts the risk bar at 0.5: 0.4 allows, 0.5 denies", () => {
    expect(synthesizeJevVerdict(confident({ riskScore: 0.4 }), THRESHOLDS, 7).verdict).toEqual({
      kind: "allow",
    });
    expect(synthesizeJevVerdict(confident({ riskScore: 0.5 }), THRESHOLDS, 7).verdict.kind).toBe(
      "deny",
    );
  });

  it("follows a raised risk line: 0.6 allows under a 0.7 line", () => {
    const raised = { ...THRESHOLDS, riskThreshold: 0.7 };
    expect(synthesizeJevVerdict(confident({ riskScore: 0.6 }), raised, 7).verdict).toEqual({
      kind: "allow",
    });
  });

  it("defers with an allow lean when intent falls short and risk is low", () => {
    // Matrix #7: the screen is clean, only the authorization link is
    // unclear — lenient allows, default asks.
    const out = synthesizeJevVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.lean).toBe("allow");
  });

  it("defers naming intent when intent falls short and risk is low", () => {
    const out = synthesizeJevVerdict(
      confident({ intentMatch: 0.2, riskScore: 0.3 }),
      THRESHOLDS,
      7,
    );
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
    expect(out.deferReason).toContain("intent_match");
    expect(out.lean).toBe("allow");
  });

  it("defers with a deny lean when confidence is low but risk is over the line", () => {
    // Matrix #5: evidence of danger never leans allow — lenient asks.
    const out = synthesizeJevVerdict(
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
    const out = synthesizeJevVerdict(
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
    const out = synthesizeJevVerdict(
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

  it("names the axis whose confidence is under the floor", () => {
    const out = synthesizeJevVerdict(confident({ riskConfidence: 0.2 }), THRESHOLDS, 7);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferReason).toContain("risk");
    expect(out.deferReason).toContain("unsure about this action");
  });
});

describe("projectRawAnswers", () => {
  it("normalizes the 0–4 risk score to the 0–1 verdict scale", () => {
    const answers = projectRawAnswers({
      danger_category: { type: "choice", choice: "none", confidence: 0.9 },
      intent_match: { type: "noul", noul: 0.2 },
      risk: { type: "score", score: 3, confidence: 0.9 },
    });
    expect(answers.riskScore).toBe(0.75);
    // Raw 3 reads critical on the quartile bands.
    const out = synthesizeJevVerdict(answers, THRESHOLDS, 1);
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
    expect(() => projectRawAnswers({})).toThrow(IncompleteJevResponseError);
    expect(() =>
      projectRawAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 0.9 },
        intent_match: { type: "noul", noul: 0.2 },
      }),
    ).toThrow(IncompleteJevResponseError);
    expect(() =>
      projectRawAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 0.9 },
        intent_match: { type: "noul", noul: 0.2 },
        risk: { type: "score", confidence: 0.9 },
      }),
    ).toThrow(IncompleteJevResponseError);
  });

  it("treats missing confidence as zero (uncertain), not malformed", () => {
    const answers = projectRawAnswers({
      danger_category: { type: "choice", choice: "none" },
      intent_match: { type: "noul", noul: 0.9 },
      risk: { type: "score", score: 1 },
    });
    expect(answers.dangerConfidence).toBe(0);
    expect(answers.riskConfidence).toBe(0);
    const out = synthesizeJevVerdict(answers, THRESHOLDS, 1);
    expect(out.verdict).toEqual({ kind: "defer" });
    expect(out.deferKind).toBe("model-defer");
  });
});
