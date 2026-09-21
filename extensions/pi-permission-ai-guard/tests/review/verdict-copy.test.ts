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

import { describe, expect, it } from "vitest";

import {
  escalationMessage,
  machineryDenyReason,
  withAgentInstruction,
} from "#src/review/verdict-copy.ts";
import { CLARIFICATION_SUPPRESSED_REASON } from "#src/review/verdict-rule.ts";

const DENY = { kind: "deny", reason: "secrets in the command" } as const;

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

describe("withAgentInstruction", () => {
  it("prepends the content instruction to a judged deny's reason", () => {
    const reason = withAgentInstruction("unsafe", "content");
    expect(reason).toBe(
      "Automatic review denied this, not the user. Do not rephrase, retry, or work around it; if the user wants it, they should ask explicitly — unsafe",
    );
  });

  it("prepends the machinery instruction to a review-failure deny's reason", () => {
    const reason = withAgentInstruction(
      "reviewer could not complete the review (no-json) — strict mode denied the request",
      "machinery",
    );
    expect(reason).toBe(
      "Automatic review failed (the reviewer, not the request). Retry later, or ask the user to request it explicitly if urgent — reviewer could not complete the review (no-json) — strict mode denied the request",
    );
  });

  it("the instruction stands alone (period-free — the host render appends its own) when the deny carries no reason", () => {
    expect(withAgentInstruction(undefined, "content")).toBe(
      "Automatic review denied this, not the user. Do not rephrase, retry, or work around it; if the user wants it, they should ask explicitly",
    );
    expect(withAgentInstruction(undefined, "machinery")).toBe(
      "Automatic review failed (the reviewer, not the request). Retry later, or ask the user to request it explicitly if urgent",
    );
  });

  it("the two variants disagree (identity vs failure framing)", () => {
    const content = withAgentInstruction("x", "content");
    const machinery = withAgentInstruction("x", "machinery");
    expect(content).toContain("not the user");
    expect(content).toContain("Do not rephrase");
    expect(machinery).toContain("Retry later");
    expect(content).not.toBe(machinery);
  });
});
