import { describe, expect, it } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { renderSplit } from "#src/render/render-split.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { resolveDiffPalette, resetPaletteForTest } from "#src/theme/palette.ts";
import { buildFakeTheme, plain } from "#test/fixtures.ts";

/**
 * The ▌ bar is indicatorStyle's ONLY rendering surface. A removed
 * compactGutter option once dropped the border column entirely in the
 * edit/write render paths, silently disabling the config — these tests
 * pin the bar's presence in both views (the option is gone now; the
 * bar's unconditional rendering is the invariant that remains).
 */
describe("the ▌ bar renders unconditionally", () => {
  it("unified view carries the bar on changed rows; none removes it", async () => {
    resetPaletteForTest();
    const palette = resolveDiffPalette(buildFakeTheme());
    const diff = parseDiff("const a = 1;\n", "const b = 2;\n");

    const bar = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      palette,
      indicator: "bar",
    });
    expect(bar).toContain("▌");
    const none = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      palette,
      indicator: "none",
    });
    expect(none).not.toContain("▌");
  });

  it("none mode collapses the indicator column entirely (one leading space total — the frame Box's pad)", async () => {
    resetPaletteForTest();
    const palette = resolveDiffPalette(buildFakeTheme());
    const diff = parseDiff("keep\nconst a = 1;\n", "keep\nconst b = 2;\n");

    const bar = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      palette,
      indicator: "bar",
    });
    const none = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      palette,
      indicator: "none",
    });
    // Bar mode: changed rows lead with the glyph; context rows hold the
    // column with a bg space (the grid stays aligned).
    const barRows = bar.split("\n").map((r) => plain(r));
    expect(barRows.some((r) => r.startsWith("▌"))).toBe(true);
    // None mode: NO indicator column at all — changed AND context rows
    // drop it together (the grid stays aligned): every none row is the
    // bar-mode row minus its first column (glyph or bg space). The
    // number's own alignment padding remains — rows lead with " N"
    // (numberWidth 2 here), never with a third leading column.
    const noneRows = none.split("\n").map((r) => plain(r));
    expect(noneRows.some((r) => r.startsWith("▌"))).toBe(false);
    const barDel = barRows.find((r) => /\d\s*-\s*const a = 1;/.test(r)) ?? "";
    const noneDel = noneRows.find((r) => /\d\s*-\s*const a = 1;/.test(r)) ?? "";
    expect(noneDel.trimEnd()).toBe(barDel.slice(1).trimEnd());
    // The changed rows still carry their numbers and signs.
    expect(/2\s*-\s*const a = 1;/.test(noneDel)).toBe(true);
    expect(noneRows.some((r) => /2\s*\+\s*const b = 2;/.test(r))).toBe(true);
    // And the bar-mode rows lead with the glyph at the same numbers.
    expect(/^▌\s*2\s*-/.test(barDel)).toBe(true);
  });

  it("split view carries the bar on wrapped and unwrapped rows alike", async () => {
    resetPaletteForTest();
    const palette = resolveDiffPalette(buildFakeTheme());
    const oldFile = Array.from({ length: 8 }, (_, i) => `line ${i + 1} old`);
    const newFile = oldFile.map((line, i) => (i < 6 ? `line ${i + 1} new` : line));
    const diff = parseDiff(oldFile.join("\n") + "\n", newFile.join("\n") + "\n");

    const out = await renderSplit({
      diff,
      language: undefined,
      maxLines: 20,
      width: 200,
      palette,
      indicator: "bar",
    });
    expect(out).toContain("▌");
  });

  it("split none mode puts a boundary space where the bar's column sat (the seam between halves)", async () => {
    resetPaletteForTest();
    const palette = resolveDiffPalette(buildFakeTheme());
    const diff = parseDiff("const a = 1;\n", "const b = 2;\n");
    const width = 120;

    const bar = await renderSplit({
      diff,
      language: undefined,
      maxLines: 20,
      width,
      palette,
      indicator: "bar",
    });
    const none = await renderSplit({
      diff,
      language: undefined,
      maxLines: 20,
      width,
      palette,
      indicator: "none",
    });
    // Bar mode: the seam IS the right gutter's glyph — `▌1 +` (the left
    // code's last char sits directly against the bar).
    const barRows = bar.split("\n").map((r) => plain(r));
    expect(barRows.some((r) => /▌\s*1 \+ const b = 2;/.test(r))).toBe(true);
    // None mode: the glyph collapses, and the SAME column stands as a
    // canvas space so the halves never fuse: the right gutter reads
    // " 1 +" — a boundary space, then its number. The row is exactly one
    // column narrower than bar mode's (the left border column collapsed;
    // the seam took its budget position — nothing appended over width).
    const noneRows = none.split("\n").map((r) => plain(r));
    expect(noneRows.some((r) => r.includes("▌"))).toBe(false);
    expect(noneRows.some((r) => r.length === width - 1 && /\s1 \+ const b = 2;/.test(r))).toBe(
      true,
    );
    for (const row of noneRows) {
      expect(row.length).toBeLessThanOrEqual(width);
    }
  });
});
