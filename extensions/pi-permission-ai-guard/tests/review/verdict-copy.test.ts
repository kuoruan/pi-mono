/**
 * Verdict-copy direct tests: the human-facing message constructors
 * (escalationMessage, machineryDenyReason, withAgentInstruction). The
 * mode x verdict mapping table itself lives in verdict-rule.test.ts.
 *
 * These assert the facts each line must carry and the shape every operator line
 * keeps, never the wording (see tests/operator-copy.ts).
 */

import { describe, expect, it } from "vitest";

import {
  approvalNotice,
  escalationMessage,
  formatDuration,
  machineryDenyReason,
  machineryDeferNotice,
  uncertainDenyReason,
  withAgentInstruction,
} from "#src/review/verdict-copy.ts";
import { CLARIFICATION_SUPPRESSED_REASON } from "#src/review/verdict-rule.ts";
import { OPERATOR_COPY_SHAPE } from "#test/operator-copy.ts";

const DENY = { kind: "deny", reason: "secrets in the command" } as const;

describe("human-facing messages", () => {
  it("escalationMessage carries the risk level and the deny reason", () => {
    const withRisk = escalationMessage(DENY, "high", "denied");
    expect(withRisk).toContain("risk high");
    expect(withRisk).toContain(DENY.reason);
    expect(withRisk).toMatch(OPERATOR_COPY_SHAPE);

    // No level: the fact sentence still carries the reason, and must not invent
    // a risk reading it does not have.
    const withoutRisk = escalationMessage(DENY, undefined, "denied");
    expect(withoutRisk).toContain(DENY.reason);
    expect(withoutRisk).not.toContain("risk");

    // No reason: the level survives on its own.
    const withoutReason = escalationMessage({ kind: "deny" }, "medium", "denied");
    expect(withoutReason).toContain("risk medium");
    expect(withoutReason).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("escalationMessage names the ask outcome when the mode softened the deny", () => {
    const asked = escalationMessage(DENY, "low", "asked");
    expect(asked).toContain("instead");
    expect(asked).toContain(DENY.reason);
    expect(asked).toMatch(OPERATOR_COPY_SHAPE);

    // The denied outcome needs no tail: the fact sentence already says it.
    expect(escalationMessage(DENY, "low", "denied")).not.toContain("instead");
  });

  it("escalationMessage carries the reason whole, however long it runs", () => {
    // A runaway ramble is the operator's only warning of what the reviewer
    // objected to. It is not cut, in either notice.
    const ramble = "y".repeat(400);
    const message = escalationMessage({ kind: "deny", reason: ramble }, "low", "denied");
    expect(message).toContain(ramble);
    expect(message).not.toContain("[...truncated...]");
  });

  it("machineryDenyReason names the failure kind and the mode, tolerating none", () => {
    const named = machineryDenyReason("no-json", "strict");
    expect(named).toContain("no-json");
    expect(named).toContain("strict");
    expect(named).toMatch(OPERATOR_COPY_SHAPE);

    // A missing kind still has to say so, and still has to name the mode.
    const unknown = machineryDenyReason(undefined, "permissive");
    expect(unknown).toContain("unknown");
    expect(unknown).toContain("permissive");
    expect(unknown).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("the defer notices name their cause", () => {
    const machinery = machineryDeferNotice("timeout");
    expect(machinery).toContain("timeout");
    expect(machinery).toMatch(OPERATOR_COPY_SHAPE);

    const uncertain = uncertainDenyReason("strict");
    expect(uncertain).toContain("strict");
    expect(uncertain).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("approvalNotice reports the fresh review's cost or names a cache replay", () => {
    const fresh = approvalNotice({ kind: "reviewer" }, { kind: "fresh", latencyMs: 42 });
    expect(fresh).toContain("42ms");
    expect(fresh).toMatch(OPERATOR_COPY_SHAPE);

    const mode = approvalNotice(
      { kind: "mode", mode: "permissive" },
      { kind: "fresh", latencyMs: 1500 },
    );
    expect(mode).toContain("permissive");
    expect(mode).toContain("1.5s");
    // The auto-approval says whose decision it was, not just the cost.
    expect(mode).not.toBe(fresh);

    const cached = approvalNotice({ kind: "reviewer" }, { kind: "cached" });
    expect(cached).toContain("cached");
    expect(cached).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("formatDuration stays in ms under a second, one-decimal seconds above", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999.6)).toBe("1000ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
  });

  it("CLARIFICATION_SUPPRESSED_REASON is the audit marker for a swallowed clarification", () => {
    expect(CLARIFICATION_SUPPRESSED_REASON).toBe("clarification-suppressed");
  });
});

describe("withAgentInstruction", () => {
  it("prepends the content instruction to a judged deny's reason", () => {
    const reason = withAgentInstruction("unsafe", "content");
    expect(reason).toContain("unsafe");
    // The identity framing and the behavioral instruction are the contract.
    expect(reason).toContain("not the user");
    expect(reason).toContain("Do not rephrase");
    expect(reason).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("prepends the machinery instruction to a review-failure deny's reason", () => {
    const reason = withAgentInstruction("no-json failure", "machinery");
    expect(reason).toContain("no-json failure");
    expect(reason).toContain("Retry later");
    expect(reason).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("the two variants disagree (identity vs failure framing)", () => {
    const content = withAgentInstruction("x", "content");
    const machinery = withAgentInstruction("x", "machinery");
    expect(content).not.toBe(machinery);
    expect(content).toContain("not the user");
    expect(machinery).not.toContain("not the user");
  });

  it("the instruction stands alone when the deny carries no reason", () => {
    // The host's agent-side render appends its own period, so the instruction
    // must not end in one, and no absent reason may leak into the text.
    for (const source of ["content", "machinery"] as const) {
      const instruction = withAgentInstruction(undefined, source);
      expect(instruction).not.toContain("undefined");
      expect(instruction).not.toMatch(/\.$/);
      expect(instruction).toMatch(OPERATOR_COPY_SHAPE);
    }
  });
});
