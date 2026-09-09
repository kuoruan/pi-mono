import { describe, expect, it } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { resolveDiffPalette, resetPaletteForTest } from "#src/theme/palette.ts";
import { buildFakeTheme, plain } from "#test/fixtures.ts";

/**
 * Build a line whose unique marker rides ~11.5k chars of padding.
 *
 * @param marker - The line's unique marker.
 * @returns The padded line.
 */
const mk = (marker: string): string => `${marker} ${"x".repeat(11_500)}`;

/**
 * The over-budget regression: when the visible window exceeds
 * MAX_HL_CHARS, highlighting is off and the plain-text del/add paths
 * consume no cursor — the ctx rows must still show their OWN content
 * (a cursor desync once handed later ctx rows the del row's content).
 */
describe("unified view over the highlight budget (plain-text paths)", () => {
  it("renders every ctx row's own content after a del block", async () => {
    resetPaletteForTest();
    const palette = resolveDiffPalette(buildFakeTheme());
    const oldFile = Array.from({ length: 30 }, (_, i) => mk(`L${i + 1}`));
    const newFile = oldFile.map((line, i) => (i === 9 ? mk("CHANGED") : line));
    const diff = parseDiff(oldFile.join("\n") + "\n", newFile.join("\n") + "\n");
    const out = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 160,
      palette,
      indicator: "bar",
    });
    const rows = plain(out).split("\n");
    // Each ctx row shows its own marker: row 12 carries "L12" — the
    // desync rendered "L11" there (the never-consumed del offset the
    // cursor by one and every later ctx row drifted).
    for (const n of [11, 12, 13]) {
      const row = rows.find((r) => new RegExp(`^\\s*${n}\\s`).test(r));
      expect(row, `ctx row ${n}`).toBeDefined();
      expect(row, `ctx row ${n} carries its own content`).toContain(`L${n}`);
    }
  });
});
