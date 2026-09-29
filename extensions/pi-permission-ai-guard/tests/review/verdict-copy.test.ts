/**
 * Verdict-copy direct tests: the human-facing message constructors
 * (escalationMessage, machineryDenyReason, withAgentInstruction). The
 * mode x verdict mapping table itself lives in verdict-rule.test.ts;
 * this file pins only the copy those cells render.
 */

import { describe, expect, it } from "vitest";

import {
  approvalNotice,
  escalationMessage,
  formatDuration,
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

  it("approvalNotice reports the fresh review's total cost or names a cache replay", () => {
    expect(approvalNotice({ kind: "reviewer" }, { kind: "fresh", latencyMs: 42 })).toBe(
      "reviewer approved this request (42ms)",
    );
    expect(
      approvalNotice({ kind: "mode", mode: "permissive" }, { kind: "fresh", latencyMs: 1500 }),
    ).toBe("mode (permissive) auto-approved this request (1.5s)");
    expect(approvalNotice({ kind: "reviewer" }, { kind: "cached" })).toBe(
      "reviewer approved this request (cached)",
    );
    expect(approvalNotice({ kind: "mode", mode: "lenient" }, { kind: "cached" })).toBe(
      "mode (lenient) auto-approved this request (cached)",
    );
  });

  it("formatDuration stays in ms under a second, one-decimal seconds above", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999.6)).toBe("1000ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
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
