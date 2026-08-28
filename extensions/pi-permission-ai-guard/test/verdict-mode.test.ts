/**
 * Verdict-mode direct tests: the full mode × verdict mapping table and
 * the human-facing message constructors. The mapping lives in one module;
 * this table pins it densely — a semantic change to any cell is a
 * one-line failure here, before it reaches the pipeline's wiring tests.
 *
 * The ladder (strictest first): hard-tier denies (riskLevel
 * high|critical, or missing) are terminal in EVERY mode. Soft denies
 * (low|medium) and the model's own uncertainty map per mode; machinery
 * failures never map to allow.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { MODE_VALUES, type Mode } from "#src/config-schema.ts";
import type { RiskLevel } from "#src/model-verdict.ts";
import {
  CLARIFICATION_SUPPRESSED_REASON,
  type ModelDeferInfo,
  applyVerdictMode,
  denyTier,
  machineryTarget,
  advisoryEscalationMessage,
  machineryDenyReason,
} from "#src/verdict-mode.ts";

type Row = [
  policy: Mode,
  verdict: AuthorizerVerdict,
  modelDefer: ModelDeferInfo | undefined,
  riskLevel: RiskLevel | undefined,
  expected: AuthorizerVerdict,
];

const DENY = { kind: "deny", reason: "secrets in the command" } as const;
const ALLOW = { kind: "allow" } as const;
const MODEL_DEFER = { kind: "defer" } as const;
const MODEL_DEFER_WITH_REASON: ModelDeferInfo = {
  kind: "model-defer",
  reason: "which file does this target?",
};

const uncertainDenyReason =
  "Reviewer was uncertain about this request — strict mode denies uncertain requests";

describe("applyVerdictMode — mapping table", () => {
  it.each<Row>([
    // Allow is never transformed, in any mode.
    ...MODE_VALUES.map((m) => [m, ALLOW, undefined, undefined, ALLOW] as Row),

    // Hard-tier denies are terminal in every mode — high, critical, AND a
    // missing risk level (absence of signal never buys leniency).
    ...MODE_VALUES.flatMap((m) =>
      ([undefined, "high", "critical"] as RiskLevel[]).map(
        (rl) => [m, DENY, undefined, rl, DENY] as Row,
      ),
    ),

    // Soft denies (low|medium) map down the ladder.
    ...(
      [
        { mode: "strict", expected: DENY },
        { mode: "default", expected: DENY },
        { mode: "advisory", expected: { kind: "defer" } },
        { mode: "lenient", expected: { kind: "defer" } },
        { mode: "permissive", expected: ALLOW },
      ] as const
    ).map(({ mode, expected }) => [mode, DENY, undefined, "low", expected] as Row),

    // The model's own uncertainty (model-defer): strict denies it, carrying
    // the clarification request as the teaching reason; default/advisory
    // ask; lenient/permissive pass.
    [
      "strict",
      MODEL_DEFER,
      MODEL_DEFER_WITH_REASON,
      undefined,
      {
        kind: "deny",
        reason: "which file does this target?",
      },
    ],
    ["default", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "defer" }],
    ["advisory", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "defer" }],
    ["lenient", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "allow" }],
    ["permissive", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "allow" }],

    // A model defer without a clarification request: strict denies with
    // the generic uncertainty reason.
    [
      "strict",
      MODEL_DEFER,
      { kind: "model-defer" },
      undefined,
      { kind: "deny", reason: uncertainDenyReason },
    ],

    // Machinery failures never map to allow: deny under the two extremes
    // (strict: fail closed; permissive: a broken reviewer must not
    // rubber-stamp), defer otherwise.
    ...[
      {
        mode: "strict",
        expected: {
          kind: "deny",
          reason:
            "reviewer could not complete the review (no-json) — strict mode denied the request",
        },
      },
      { mode: "default", expected: { kind: "defer" } },
      { mode: "advisory", expected: { kind: "defer" } },
      { mode: "lenient", expected: { kind: "defer" } },
      {
        mode: "permissive",
        expected: {
          kind: "deny",
          reason:
            "reviewer could not complete the review (no-json) — permissive mode denied the request",
        },
      },
    ].map(
      ({ mode, expected }) => [mode, MODEL_DEFER, { kind: "no-json" }, undefined, expected] as Row,
    ),

    // A machinery defer without a classified kind: "unknown", denied under
    // the extremes.
    [
      "strict",
      MODEL_DEFER,
      undefined,
      undefined,
      {
        kind: "deny",
        reason: "reviewer could not complete the review (unknown) — strict mode denied the request",
      },
    ],
    ["default", MODEL_DEFER, undefined, undefined, { kind: "defer" }],
    [
      "permissive",
      MODEL_DEFER,
      undefined,
      undefined,
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (unknown) — permissive mode denied the request",
      },
    ],
  ])("%s × %j (deferKind %j, risk %j) → %j", (policy, verdict, modelDefer, riskLevel, expected) => {
    expect(applyVerdictMode(policy, verdict, modelDefer, riskLevel)).toEqual(expected);
  });
});

describe("denyTier", () => {
  it("classifies high|critical and missing risk as hard, low|medium as soft", () => {
    expect(denyTier(undefined)).toBe("hard");
    expect(denyTier("high")).toBe("hard");
    expect(denyTier("critical")).toBe("hard");
    expect(denyTier("low")).toBe("soft");
    expect(denyTier("medium")).toBe("soft");
  });
});

describe("machineryTarget", () => {
  it("denies under the two extremes and defers otherwise, never allowing", () => {
    expect(machineryTarget("strict")).toBe("deny");
    expect(machineryTarget("permissive")).toBe("deny");
    expect(machineryTarget("default")).toBe("defer");
    expect(machineryTarget("advisory")).toBe("defer");
    expect(machineryTarget("lenient")).toBe("defer");
  });
});

describe("human-facing messages", () => {
  it("advisoryEscalationMessage carries the risk level and the deny reason", () => {
    expect(advisoryEscalationMessage(DENY, "high", "denied")).toBe(
      "reviewer denied this request (risk high) — secrets in the command",
    );
    expect(advisoryEscalationMessage(DENY, undefined, "denied")).toBe(
      "reviewer denied this request — secrets in the command",
    );
    expect(advisoryEscalationMessage({ kind: "deny" }, "medium", "denied")).toBe(
      "reviewer denied this request (risk medium)",
    );
  });

  it("advisoryEscalationMessage names the ask outcome when the mode softened the deny", () => {
    expect(advisoryEscalationMessage(DENY, "low", "asked")).toBe(
      "reviewer denied this request (risk low) — secrets in the command — asking you instead",
    );
    // The denied outcome needs no tail — the fact sentence already says it.
    expect(advisoryEscalationMessage(DENY, "low", "denied")).not.toContain("instead");
  });

  it("advisoryEscalationMessage carries a sane reason whole; only a ramble hits the ceiling", () => {
    // ~150 is the prompt's anchor for a concise sentence — comfortably
    // under the 160 display ceiling.
    const sane = "x".repeat(120);
    expect(advisoryEscalationMessage({ kind: "deny", reason: sane }, "low", "denied")).toContain(
      sane,
    );
    const ramble = "y".repeat(400);
    const message = advisoryEscalationMessage({ kind: "deny", reason: ramble }, "low", "denied");
    expect(message).not.toContain("\n");
    expect(message).toContain("[...truncated...]");
    expect(message).toContain("yyy");
  });

  it("machineryDenyReason names the failure kind and the mode, tolerating none", () => {
    expect(machineryDenyReason("no-json", "strict")).toBe(
      "reviewer could not complete the review (no-json) — strict mode denied the request",
    );
    expect(machineryDenyReason(undefined, "permissive")).toBe(
      "reviewer could not complete the review (unknown) — permissive mode denied the request",
    );
  });

  it("CLARIFICATION_SUPPRESSED_REASON is the audit marker souping a swallowed clarification", () => {
    expect(CLARIFICATION_SUPPRESSED_REASON).toBe("clarification-suppressed");
  });
});
