import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { parsePatchFiles } from "#src/core/diff.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { resolveDiffPalette } from "#src/theme/palette.ts";
import { buildFakeTheme, plain } from "#test/fixtures.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

/**
 * The phantom-blank regression: a patch whose NEW numbers run wider than
 * its OLD numbers (an insert-heavy edit that pushes the tail's ctx lines
 * from 2-digit old numbers across into 3-digit new numbers). The gutter
 * must size for the wider side — an oldNum-only budget leaves every
 * 3-digit row one column overwide, and the Text wrap pass turns that
 * overflow into a phantom blank continuation row after each such row.
 */
const PATCH = `--- doc.md
+++ doc.md
@@ -70,8 +70,11 @@
 line 70
 line 71
 line 72
-line 73
+line 73 grown
+line 73b
+line 73c
+line 73d
 line 74
 line 75
 line 76
 line 77
@@ -95,7 +99,8 @@
 line 95
 line 96
 line 97
-line 98
+line 98 changed
+line 98b
 line 99
 line 100
 line 101
`;

describe("line-number width covers both sides (the phantom-blank fix)", () => {
  it("sizes the gutter for the wider number side, keeping every row one line through the Text wrap", async () => {
    vol.fromJSON({ "/work/doc.md": "placeholder" });
    const parsed = parsePatchFiles(PATCH)[0];
    expect(parsed).toBeDefined();
    const diff = parsed!;

    const theme = buildFakeTheme({ syntaxColors: true });
    const out = await renderUnified({
      diff,
      language: "markdown",
      maxLines: 60,
      width: 120,
      palette: resolveDiffPalette(theme),
      piTheme: theme,
      indicator: "bar",
    });

    // The TUI's own wrap pass is the oracle: an under-sized gutter makes
    // every 3-digit row one column overwide, and the wrap turns that
    // overflow into a phantom blank continuation row after each such row.
    const text = new Text(out, 0, 0);
    const rows = text.render(120).map((r) => plain(r));
    const phantoms = rows.filter((r) => r.trim() === "");
    expect(phantoms).toEqual([]);
    // No genuine wraps here (every body fits): every rendered row carries
    // a number or a separator — the phantom signature (whitespace-only
    // rows) is already asserted empty above.
    // The 3-digit new numbers render with their numbers intact.
    expect(rows.some((r) => r.includes("100"))).toBe(true);
    expect(rows.some((r) => r.includes("101"))).toBe(true);
  });
});
