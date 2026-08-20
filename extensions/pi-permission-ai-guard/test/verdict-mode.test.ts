/**
 * Verdict-mode direct tests: the full mode × verdict mapping table and
 * the escalation message constructors. The mapping lives in one module;
 * this table pins it densely — a semantic change to any cell is a
 * one-line failure here, before it reaches the pipeline's wiring tests.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import type { Mode } from "#src/config-schema.ts";
import {
  AUTO_DEFER_DENY_REASON,
  type ModelDeferInfo,
  applyVerdictMode,
  machineryDeferMessage,
  manualEscalationMessage,
} from "#src/verdict-mode.ts";

type Row = [
  policy: Mode,
  verdict: AuthorizerVerdict,
  modelDefer: ModelDeferInfo | undefined,
  expected: AuthorizerVerdict,
];

const DENY = { kind: "deny", reason: "secrets in the command" } as const;
const MODEL_DEFER = { kind: "defer" } as const;
const MODEL_DEFER_WITH_REASON: ModelDeferInfo = {
  kind: "model-defer",
  reason: "which file does this target?",
};

describe("applyVerdictMode — mapping table", () => {
  it.each<Row>([
    // Allow is never transformed, in any mode.
    ["manual", { kind: "allow" }, undefined, { kind: "allow" }],
    ["default", { kind: "allow" }, undefined, { kind: "allow" }],
    ["auto", { kind: "allow" }, undefined, { kind: "allow" }],

    // Deny: manual hands it to the human; default/auto keep it terminal.
    ["manual", DENY, undefined, { kind: "defer" }],
    ["default", DENY, undefined, DENY],
    ["auto", DENY, undefined, DENY],

    // The model's own uncertainty (model-defer): auto denies it, carrying
    // the clarification request as the teaching reason.
    ["manual", MODEL_DEFER, MODEL_DEFER_WITH_REASON, { kind: "defer" }],
    ["default", MODEL_DEFER, MODEL_DEFER_WITH_REASON, { kind: "defer" }],
    [
      "auto",
      MODEL_DEFER,
      MODEL_DEFER_WITH_REASON,
      { kind: "deny", reason: "which file does this target?" },
    ],

    // A model defer without a clarification request: auto denies with the
    // generic reason.
    [
      "auto",
      MODEL_DEFER,
      { kind: "model-defer" },
      { kind: "deny", reason: AUTO_DEFER_DENY_REASON },
    ],

    // Machinery failures are NOT safety verdicts: they pass through to the
    // human escape valve in every mode, auto included.
    ["auto", MODEL_DEFER, { kind: "no-json" }, { kind: "defer" }],
    ["default", MODEL_DEFER, { kind: "timeout" }, { kind: "defer" }],
    ["manual", MODEL_DEFER, { kind: "empty-reply" }, { kind: "defer" }],
    ["auto", MODEL_DEFER, undefined, { kind: "defer" }],
  ])("%s × %j (deferKind %j) → %j", (policy, verdict, modelDefer, expected) => {
    expect(applyVerdictMode(policy, verdict, modelDefer)).toEqual(expected);
  });
});

describe("escalation messages", () => {
  it("manualEscalationMessage carries the risk level and the deny reason", () => {
    expect(manualEscalationMessage(DENY, "high")).toBe(
      "ai-guard reviewer denied this request (risk: high) — secrets in the command",
    );
    expect(manualEscalationMessage(DENY, undefined)).toBe(
      "ai-guard reviewer denied this request — secrets in the command",
    );
    expect(manualEscalationMessage({ kind: "deny" }, "medium")).toBe(
      "ai-guard reviewer denied this request (risk: medium)",
    );
  });

  it("machineryDeferMessage names the failure kind, tolerating none", () => {
    expect(machineryDeferMessage("no-json")).toBe(
      "ai-guard: reviewer could not complete the review (no-json) — deferring to you",
    );
    expect(machineryDeferMessage(undefined)).toBe(
      "ai-guard: reviewer could not complete the review (unknown) — deferring to you",
    );
  });
});
