import { describe, expect, it } from "vitest";

import { ellipsizeMiddle, fitHeaderLine } from "#src/render/ellipsis.ts";

describe("ellipsizeMiddle", () => {
  it("returns short lines untouched", () => {
    expect(ellipsizeMiddle("$ git status", 80)).toBe("$ git status");
  });

  it("cuts the middle with a single ellipsis, keeping both ends", () => {
    const out = ellipsizeMiddle("$ git checkout --track origin/very-long-branch-name", 30);
    expect(out).toContain("…");
    expect(out.startsWith("$ git")).toBe(true);
    expect(out.endsWith("branch-name")).toBe(true);
  });

  it("never emits a bare reset (the row background flows through the cut)", () => {
    const styled = `\x1b[38;2;1;2;3m$ git checkout --track origin/${"very-long-".repeat(10)}branch-name\x1b[39m`;
    const out = ellipsizeMiddle(styled, 30);
    expect(out).not.toContain("\x1b[0m");
    expect(out).not.toContain("\x1b[m");
  });

  it("folds newlines to ⏎ so the header stays one row", () => {
    const out = ellipsizeMiddle("$ python3 - <<'EOF'\nimport re\nprint(1)\nEOF", 30);
    expect(out).not.toContain("\n");
    expect(out).toContain("⏎ ");
    expect(out).toContain("…");
  });
});

describe("fitHeaderLine", () => {
  it("pins the suffix outside the ellipsis budget", () => {
    const out = fitHeaderLine("$ git checkout --track origin/very-long-branch-name", " · ✓", 24);
    expect(out.endsWith(" · ✓")).toBe(true);
    expect(out).toContain("…");
  });

  it("returns the full line when width is undefined", () => {
    expect(fitHeaderLine("$ git status", " · ✓", undefined)).toBe("$ git status · ✓");
  });
});
