import { describe, expect, it } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import {
  lastHunkNewStart,
  MAX_SEED_CHARS,
  needsSeed,
  seedFromLines,
  seedFromText,
} from "#src/theme/seed.ts";

describe("seed lifecycle (seed.ts)", () => {
  it("gates on embedded grammars", () => {
    expect(needsSeed("vue")).toBe(true);
    expect(needsSeed("typescript")).toBe(false);
    expect(needsSeed(undefined)).toBe(false);
  });

  it("slices the last hunk's prefix, view-independent", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `row${i}`);
    const oldText = `${rows.join("\n")}\n`;
    const changed = [...rows];
    changed[2] = "CHANGED near top";
    changed[50] = "CHANGED deep";
    const newText = `${changed.join("\n")}\n`;
    const diff = parseDiff(oldText, newText);
    const start = lastHunkNewStart(diff);
    expect(start).toBeGreaterThan(10);
    const seed = seedFromText(newText, "vue")?.(start);
    expect(seed).toBeDefined();
    expect(seed).toContain("CHANGED near top");
    expect(seed).not.toContain("CHANGED deep");
  });

  it("returns undefined at/before line 1", () => {
    expect(seedFromText("a\nb\n", "vue")?.(1)).toBeUndefined();
    expect(seedFromLines(() => ["a", "b"], "vue")?.(1)).toBeUndefined();
  });

  it("returns undefined for non-seed languages", () => {
    expect(seedFromText("a\nb\n", "typescript")).toBeUndefined();
    expect(seedFromLines(() => ["a"], "typescript")).toBeUndefined();
  });

  it("drops oversized prefixes at the source", () => {
    const big = `${"x".repeat(MAX_SEED_CHARS + 1)}\n tail\n`;
    expect(seedFromText(big, "vue")?.(2)).toBeUndefined();
  });

  it("lastHunkNewStart falls back to 1 without hunks", () => {
    expect(lastHunkNewStart({ lines: [], added: 0, removed: 0 })).toBe(1);
  });
});
