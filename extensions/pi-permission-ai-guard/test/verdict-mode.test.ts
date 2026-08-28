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
  escalationMessage,
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

    // Soft denies (low|medium) map down the ladder — default asks (the
    // resting mode forwards every flag to the human; only hard-tier
    // denies are final there).
    ...(
      [
        { mode: "strict", expected: DENY },
        { mode: "default", expected: { kind: "defer" } },
        { mode: "lenient", expected: { kind: "defer" } },
        { mode: "permissive", expected: ALLOW },
      ] as const
    ).map(({ mode, expected }) => [mode, DENY, undefined, "low", expected] as Row),

    // The model's own uncertainty (model-defer): strict denies it, carrying
    // the clarification request as the teaching reason; default asks;
    // lenient/permissive pass.
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
    ["lenient", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "allow" }],
    ["permissive", MODEL_DEFER, MODEL_DEFER_WITH_REASON, undefined, { kind: "allow" }],

    // The lean split: benign-leaned doubts pass in lenient but ASK in
    // default (an unresolved verdict always keeps an ask path — the
    // intent question must be able to reach the authorizer); deny at
    // strict (a lean is not an allow); danger-leaned doubts ask everywhere
    // below strict (lenient's auto-pass breaks); permissive is lean-inert
    // (its contract is absolute).
    ...(
      [
        {
          lean: "allow",
          expected: {
            strict: { kind: "deny", reason: "which file does this target?" },
            default: { kind: "defer" },
            lenient: ALLOW,
            permissive: ALLOW,
          } as const,
        },
        {
          lean: "deny",
          expected: {
            strict: { kind: "deny", reason: "which file does this target?" },
            default: { kind: "defer" },
            lenient: { kind: "defer" },
            permissive: ALLOW,
          } as const,
        },
      ] as const
    ).flatMap(({ lean, expected }) =>
      MODE_VALUES.map(
        (m) =>
          [m, MODEL_DEFER, { ...MODEL_DEFER_WITH_REASON, lean }, undefined, expected[m]] as Row,
      ),
    ),

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
    expect(machineryTarget("lenient")).toBe("defer");
  });
});

describe("human-facing messages", () => {
  it("escalationMessage carries the risk level and the deny reason", () => {
    expect(escalationMessage(DENY, "high", "denied")).toBe(
      "reviewer denied this request (risk high) — secrets in the command",
    );
    expect(escalationMessage(DENY, undefined, "denied")).toBe(
      "reviewer denied this request — secrets in the command",
    );
    expect(escalationMessage({ kind: "deny" }, "medium", "denied")).toBe(
      "reviewer denied this request (risk medium)",
    );
  });

  it("escalationMessage names the ask outcome when the mode softened the deny", () => {
    expect(escalationMessage(DENY, "low", "asked")).toBe(
      "reviewer denied this request (risk low) — secrets in the command — asking you instead",
    );
    // The denied outcome needs no tail — the fact sentence already says it.
    expect(escalationMessage(DENY, "low", "denied")).not.toContain("instead");
  });

  it("escalationMessage carries a sane reason whole; only a ramble hits the ceiling", () => {
    // ~150 is the prompt's anchor for a concise sentence — comfortably
    // under the 200 display ceiling.
    const sane = "x".repeat(120);
    expect(escalationMessage({ kind: "deny", reason: sane }, "low", "denied")).toContain(sane);
    const ramble = "y".repeat(400);
    const message = escalationMessage({ kind: "deny", reason: ramble }, "low", "denied");
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

describe("the ladder's structural invariant — contiguous bands in suspicion order", () => {
  // The suspicion order: allow < defer+lean:allow < defer neutral <
  // defer+lean:deny < soft deny < hard deny. Each mode's mapping must be
  // three CONTIGUOUS bands (allow / ask / deny) on this line — a special
  // case that fragments the bands (e.g. allow → ask → allow) is a
  // structural break, not a tweak. Pinned so future lane edits that cut a
  // band apart fail here instead of shipping.
  const rank = { allow: 0, defer: 1, deny: 2 } as const;

  // The six verdict states in suspicion order — shared by the band
  // contiguity and the ask-path invariant (the last two, soft and hard
  // deny, differ only in riskLevel).
  const SUSPICION_ORDER_INPUTS: Array<
    [AuthorizerVerdict, ModelDeferInfo | undefined, RiskLevel | undefined]
  > = [
    [{ kind: "allow" }, undefined, undefined],
    [{ kind: "defer" }, { kind: "model-defer", lean: "allow" }, undefined],
    [{ kind: "defer" }, { kind: "model-defer" }, undefined],
    [{ kind: "defer" }, { kind: "model-defer", lean: "deny" }, undefined],
    [{ kind: "deny", reason: "x" }, undefined, "low"],
    [{ kind: "deny", reason: "x" }, undefined, "high"],
  ];

  function bandSequence(mode: Mode): number[] {
    return SUSPICION_ORDER_INPUTS.map(
      ([verdict, modelDefer, riskLevel]) =>
        rank[applyVerdictMode(mode, verdict, modelDefer, riskLevel).kind],
    );
  }

  it.each(MODE_VALUES)("%s's outputs are three contiguous bands", (mode) => {
    const seq = bandSequence(mode);
    // Contiguity = the distinct bands, in first-appearance order, are
    // monotonically increasing — a band never REAPPEARS after a stricter
    // one appeared (allow → ask → allow fragments the ladder; allow →
    // deny straight is fine — the ask cut just sits outside this mode's
    // range). The assertion names the sequence on failure.
    const distinct: number[] = [];
    for (const band of seq) {
      if (distinct[distinct.length - 1] !== band) distinct.push(band);
    }
    expect(
      distinct.every((b, i) => i === 0 || b > distinct[i - 1]!),
      `${mode}: band sequence ${seq.join(" → ")}`,
    ).toBe(true);
  });

  it("every unresolved verdict keeps an ask path in at least one mode", () => {
    // The intent-check invariant: a defer (any lean) and a soft deny are
    // UNRESOLVED judgments — each must ask the human in at least one
    // mode, so the intent question can always reach the authorizer.
    // Only decisive verdicts (allow, hard deny) may bypass every ask.
    const unresolved = SUSPICION_ORDER_INPUTS.slice(1, 5);
    for (const [verdict, modelDefer, riskLevel] of unresolved) {
      const asks = MODE_VALUES.some(
        (m) => applyVerdictMode(m, verdict, modelDefer, riskLevel).kind === "defer",
      );
      expect(asks, `${JSON.stringify(verdict)} lean=${modelDefer?.lean ?? "none"}`).toBe(true);
    }
  });
});
