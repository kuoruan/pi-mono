import { describe, expect, it } from "vitest";

import { measurePlain } from "#src/core/ansi.ts";
import { parseDiff, parsePatchFiles } from "#src/core/diff.ts";
import { renderSplit } from "#src/render/render-split.ts";
import { resolveDiffPalette, resetPaletteForTest } from "#src/theme/palette.ts";
import { buildFakeTheme, plain } from "#test/fixtures.ts";

const PATCH = [
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -10,3 +10,4 @@ function context() {",
  " unchanged line",
  "-removed line",
  "+added one",
  "+added three",
  " another context",
  "@@ -40,2 +41,2 @@ function later() {",
  " ctx forty",
  "-old forty",
  "+new forty",
].join("\n");

async function renderTestSplit(): Promise<string[]> {
  resetPaletteForTest();
  const files = parsePatchFiles(PATCH);
  const theme = buildFakeTheme({ syntaxColors: true });
  const palette = resolveDiffPalette(theme);
  const output = await renderSplit({
    diff: files[0]!,
    language: "ts",
    maxLines: 999,
    width: 120,
    palette,
    piTheme: theme,
    indicator: "bar",
  });
  return output.split("\n").map(plain);
}

describe("split view geometry", () => {
  it("keeps right-half content at the same column on every row (unpaired rows)", async () => {
    const lines = await renderTestSplit();
    // Paired add and unpaired add: both are right-half content and must
    // start at the same column — the missing left half pads with a blank
    // placeholder instead of collapsing the row.
    const paired = lines.find((l) => l.includes("added one"));
    const unpaired = lines.find((l) => l.includes("added three"));
    expect(paired).toBeDefined();
    expect(unpaired).toBeDefined();
    expect(paired!.indexOf("added one")).toBe(unpaired!.indexOf("added three"));
    // The unpaired row's left half is blank (no gutter number, no border).
    expect(unpaired!.slice(0, unpaired!.indexOf("▌"))).toMatch(/^ +$/);
  });

  it("counts hidden lines in unified units: ctx rows once, pairs twice", async () => {
    // The invariant: shown N == total logical lines − logical lines
    // consumed by visible rows. A visible del+add pair consumes TWO
    // logical lines (unified shows them as two rows); a ctx row — which
    // shares one DiffLine across both halves — consumes exactly ONE (a
    // past bug counted it twice, inflating N by one per hidden ctx row).
    // maxLines=3 → visible rows: sep(1) + ctx(1) + del/add pair(2).
    resetPaletteForTest();
    const files = parsePatchFiles(PATCH);
    const diff = files[0]!;
    const theme = buildFakeTheme({ syntaxColors: true });
    const palette = resolveDiffPalette(theme);
    const split = await renderSplit({
      diff,
      language: "ts",
      maxLines: 3,
      width: 120,
      palette,
      piTheme: theme,
      indicator: "bar",
    });
    const m = plain(split).match(/\.\.\. \((\d+) more lines\)/);
    expect(m).not.toBeNull();
    const total = diff.lines.length;
    const consumed = 1 + 1 + 2; // sep row, ctx row, one paired row
    expect(Number(m![1])).toBe(total - consumed);
  });

  it("separator rows carry the row background across the full width", async () => {
    // The sep label area must not show a background hole: every plain
    // row is either fully padded or the sep line itself, which opens
    // background for the whole row (fitAnsi pads the remainder).
    const lines = await renderTestSplit();
    const sep = lines.find((l) => l.includes("function later() {"));
    expect(sep).toBeDefined();
    // Plain text reaches the full 120-col row: the sep line ends with
    // padding spaces, not a mid-row background break.
    expect(sep!.length).toBeGreaterThanOrEqual(119);
  });

  it("renders each separator label exactly once, full width", async () => {
    const lines = await renderTestSplit();
    expect(lines.filter((l) => l.includes("function context() {")).length).toBe(1);
    expect(lines.filter((l) => l.includes("function later() {")).length).toBe(1);
    expect(lines.filter((l) => l.includes("+27 lines")).length).toBe(1);
  });

  it("keeps every content row at the exact two-half width", async () => {
    const lines = await renderTestSplit();
    const contentRows = lines.filter((l) => /[0-9]/.test(l) || l.includes("▌"));
    // All content rows share one exact width (each half is gutter+code,
    // padded); the sep rows share it too (full-width label budget).
    const widths = new Set(contentRows.map((l) => l.length));
    expect(widths.size).toBe(1);
  });
});

describe("split column alignment (wrapped and padded rows)", () => {
  it("every row's right half starts at the same column (trailing-space and CJK-wrap lines)", async () => {
    resetPaletteForTest();
    const palette = resolveDiffPalette(buildFakeTheme());
    // Left half: a line with trailing spaces (the old trimEnd stripped its
    // padding) and a 60-column CJK line that wraps inside the half.
    const cjk = "中".repeat(30);
    const diff = parseDiff(`const a = 1;   \n${cjk}\n`, `const b = 2;   \n${cjk}\n`);
    const out = await renderSplit({
      diff,
      language: undefined,
      maxLines: 40,
      width: 160,
      palette,
      indicator: "bar",
    });
    const plains = out.split("\n").map((r) => plain(r));
    expect(plains.length).toBeGreaterThanOrEqual(2);
    // The right half's change indicator (▌) must sit at one fixed column
    // across ALL rows that carry one (row 1 and the wrapped row 2).
    const barCols = plains.map((p) => p.indexOf("▌")).filter((i) => i !== -1);
    expect(new Set(barCols).size).toBe(1);
    // Every row occupies exactly the render width (160 columns; measure
    // CJK as two columns via codePointWidth semantics).
    for (const p of plains) {
      expect(measurePlain(p)).toBe(160);
    }
  });
});
