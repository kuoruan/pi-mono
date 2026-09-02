import { describe, expect, it } from "vitest";

import {
  parseVerdictObject,
  parseTextFallback,
  GENERIC_DENY_REASON,
} from "#src/model/model-verdict.ts";

describe("parseVerdictObject", () => {
  it("parses allow verdict", () => {
    const result = parseVerdictObject({ verdict: "allow" }, 100);
    expect(result.verdict).toEqual({ kind: "allow" });
    expect(result.latencyMs).toBe(100);
  });

  it("parses deny verdict with reason", () => {
    const result = parseVerdictObject({ verdict: "deny", reason: "Dangerous command" }, 200);
    expect(result.verdict).toEqual({ kind: "deny", reason: "Dangerous command" });
  });

  it("uses generic reason for deny without reason", () => {
    const result = parseVerdictObject({ verdict: "deny" }, 100);
    expect(result.verdict).toEqual({ kind: "deny", reason: GENERIC_DENY_REASON });
  });

  it("falls back to generic reason for deny with whitespace-only reason", () => {
    const result = parseVerdictObject({ verdict: "deny", reason: "   " }, 100);
    expect(result.verdict).toEqual({ kind: "deny", reason: GENERIC_DENY_REASON });
  });

  it("falls back to generic reason for deny with zero-width-only reason", () => {
    const result = parseVerdictObject({ verdict: "deny", reason: "\u200B\u200B" }, 100);
    expect(result.verdict).toEqual({ kind: "deny", reason: GENERIC_DENY_REASON });
  });

  it("parses defer verdict", () => {
    const result = parseVerdictObject({ verdict: "defer" }, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("model-defer");
  });

  it("retains a defer reason for audit logging", () => {
    const result = parseVerdictObject(
      { verdict: "defer", reason: "The action target is not visible." },
      100,
    );
    expect(result.deferReason).toBe("The action target is not visible.");
  });

  it("omits defer reason when empty, whitespace, or non-string", () => {
    const empty = parseVerdictObject({ verdict: "defer", reason: "" }, 100);
    expect(empty.deferReason).toBeUndefined();

    const whitespace = parseVerdictObject({ verdict: "defer", reason: "   " }, 100);
    expect(whitespace.deferReason).toBeUndefined();

    const nonString = parseVerdictObject({ verdict: "defer", reason: null }, 100);
    expect(nonString.deferReason).toBeUndefined();

    const missing = parseVerdictObject({ verdict: "defer" }, 100);
    expect(missing.deferReason).toBeUndefined();
  });

  it("retains a valid lean on a defer verdict", () => {
    const allowLean = parseVerdictObject({ verdict: "defer", lean: "allow" }, 100);
    expect(allowLean.lean).toBe("allow");

    const denyLean = parseVerdictObject(
      { verdict: "defer", reason: "what does this script do?", lean: "deny" },
      100,
    );
    expect(denyLean.lean).toBe("deny");
  });

  it("degrades an invalid or absent lean to neutral — never invalidating the defer", () => {
    // A defer is a valid verdict regardless of its bonus field; "maybe",
    // a number, or an omission all mean neutral.
    for (const bad of ["maybe", "unsure", "", "ALLOW", 1, null, undefined]) {
      const result = parseVerdictObject({ verdict: "defer", lean: bad }, 100);
      expect(result.verdict).toEqual({ kind: "defer" });
      expect(result.deferKind).toBe("model-defer");
      expect(result.lean).toBeUndefined();
    }
  });

  it("preserves complete model explanations for deny and defer", () => {
    const longReason = "x".repeat(201);
    const deny = parseVerdictObject({ verdict: "deny", reason: longReason }, 100);
    const defer = parseVerdictObject({ verdict: "defer", reason: longReason }, 100);
    expect(deny.verdict).toEqual({ kind: "deny", reason: longReason });
    expect(defer.deferReason).toBe(longReason);
  });

  it("defers on unknown verdict value", () => {
    const result = parseVerdictObject({ verdict: "maybe" }, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("invalid-verdict-value");
  });

  it("handles missing verdict field", () => {
    const result = parseVerdictObject({ reason: "no verdict" }, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("invalid-verdict-value");
  });

  it("parses riskLevel", () => {
    const result = parseVerdictObject({ verdict: "deny", reason: "x", riskLevel: "high" }, 100);
    expect(result.riskLevel).toBe("high");
  });

  it("ignores invalid riskLevel", () => {
    const result = parseVerdictObject({ verdict: "allow", riskLevel: "extreme" }, 100);
    expect(result.riskLevel).toBeUndefined();
  });
});

describe("parseTextFallback", () => {
  it("parses JSON with verdict", () => {
    const text = 'Here is my verdict: {"verdict": "allow"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("parses JSON with deny and reason", () => {
    const text = '{"verdict": "deny", "reason": "Unsafe"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "deny", reason: "Unsafe" });
  });

  it("defers on non-JSON text", () => {
    const result = parseTextFallback("I cannot decide", 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("no-json");
  });

  it("defers on invalid JSON verdict", () => {
    const text = '{"verdict": "maybe"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
  });

  it("defers on malformed JSON", () => {
    const text = "{ broken json, no closing";
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("no-json");
    expect(result.rawReply).toBe(text);
  });

  it("defers when braces are balanced but content is invalid JSON", () => {
    // {verdict: allow} is brace-balanced but parseJsonWithRepair rejects
    // unquoted keys, so extractFirstJsonObject returns null and the fallback defers.
    const text = "{verdict: allow}";
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("no-json");
  });

  it("parses JSON with raw control chars in strings (parseJsonWithRepair)", () => {
    // Models sometimes emit raw newlines inside string values. Raw JSON.parse
    // rejects these, but pi-ai's parseJsonWithRepair escapes them first.
    const text = 'Here: {"verdict":"deny","reason":"line1\nline2"} done';
    const result = parseTextFallback(text, 100);
    expect(result.verdict.kind).toBe("deny");
    expect(result.verdict).toHaveProperty("reason", "line1 line2");
  });

  it("defers on text without JSON braces", () => {
    const result = parseTextFallback("no json here", 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("no-json");
  });

  it("parses embedded JSON with surrounding text", () => {
    const text = 'Based on my analysis: {"verdict": "deny", "reason": "unsafe"} as decided.';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "deny", reason: "unsafe" });
  });

  it("handles undefined args gracefully", () => {
    // parseVerdictObject always receives a Record from extractFirstJsonObject,
    // but test the edge case of an empty object.
    const result = parseVerdictObject({}, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("invalid-verdict-value");
  });
});

describe("parseTextFallback — balanced JSON extraction", () => {
  it("extracts nested JSON objects", () => {
    const text = 'Here: {"verdict":"allow","meta":{"nested":true}} done';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("extracts first JSON object when multiple exist", () => {
    const text = '{"verdict":"deny","reason":"first"} then {"verdict":"allow"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "deny", reason: "first" });
  });

  it("handles JSON with braces inside string values", () => {
    const text = 'Result: {"verdict":"deny","reason":"has } brace"} end';
    const result = parseTextFallback(text, 100);
    expect(result.verdict.kind).toBe("deny");
    expect(result.verdict).toHaveProperty("reason");
  });

  it("defers on unbalanced braces", () => {
    const text = '{"verdict":"allow"'; // no closing brace
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("no-json");
  });

  it("extracts JSON after string-internal braces", () => {
    const text = 'The command uses `{var}` syntax. Verdict: {"verdict":"allow"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict.kind).toBe("allow");
  });

  it("defers when no JSON present", () => {
    const result = parseTextFallback("just plain text", 100);
    expect(result.verdict).toEqual({ kind: "defer" });
  });

  it("respects escaped quotes in string values", () => {
    // The reason contains an escaped quote + brace; the extractor must not
    // treat the brace inside the string as a structural brace.
    const text = '{"verdict":"deny","reason":"say \\"hi\\" {often}"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict.kind).toBe("deny");
    expect(result.verdict).toHaveProperty("reason");
  });

  it("skips an unparseable object and extracts the next valid one", () => {
    const text = '{bad} {"verdict":"allow"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("defers on a malformed verdict attempt rather than scanning forward to a later object", () => {
    // A verdict-shaped-but-unparseable first candidate (unquoted keys, which
    // parseJsonWithRepair does not fix) must defer — not be overridden by an
    // unrelated later object. This prevents a deny→allow flip when the model
    // wraps a malformed deny and then includes an allow example in reasoning.
    const text = '{verdict: "deny", reason: "x"} {"verdict":"allow"}';
    const result = parseTextFallback(text, 100);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("no-json");
    expect(result.rawReply).toBe(text);
  });
});
