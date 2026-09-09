import { describe, expect, it } from "vitest";

import { inertText } from "#src/core/ansi.ts";

describe("inertText (terminal-injection defense, ADR 0004)", () => {
  it("maps control characters to caret notation (cat -v semantics)", () => {
    expect(inertText("a\x1b[31mb")).toBe("a^[[31mb");
    expect(inertText("\x1b]52;c;AAA\x07")).toBe("^[]52;c;AAA^G"); // OSC 52 payload defused
    expect(inertText("a\rb")).toBe("a^Mb");
    expect(inertText("x\x7f")).toBe("x^?");
    expect(inertText("\x00\x01\x1f")).toBe("^@^A^_");
    expect(inertText("\u009b31m")).toBe("^[31m"); // C1 CSI → its C0 equivalent
  });

  it("passes tabs and newlines through (line structure, not payload)", () => {
    expect(inertText("\t")).toBe("\t");
    expect(inertText("line\nline")).toBe("line\nline");
  });

  it("returns the input unchanged on the fast path", () => {
    const clean = "const value = 1; // clean source";
    expect(inertText(clean)).toBe(clean);
  });

  it("is total: no output character can start a control sequence", () => {
    const nasty = "\x1b\x0b\x0c\x08\x7f\u0085\u009b";
    const out = inertText(nasty);
    for (const ch of out) {
      const code = ch.codePointAt(0)!;
      expect(code >= 0x20 && code !== 0x7f).toBe(true);
    }
  });
});
