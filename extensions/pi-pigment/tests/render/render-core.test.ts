/**
 * Tests for the render cores not covered by the snapshot pipeline: the
 * unified view (the split fallback), word-level emphasis on unhighlighted
 * lines, separators, wrapping budgets, and the header helpers.
 */

import { describe, expect, it } from "vitest";

import { iterateCells } from "#src/core/ansi.ts";
import type { DiffLine, ParsedDiff } from "#src/core/diff.ts";
import { parseDiff, parsePatchFiles } from "#src/core/diff.ts";
import { formatToolErrorResult, setToolErrorBg } from "#src/render/error-frame.ts";
import { summarize } from "#src/render/header.ts";
import { renderSplit } from "#src/render/render-split.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { borderBar, lineNumberWidth } from "#src/render/row-frame.ts";
import { shouldUseSplit } from "#src/render/split-verdict.ts";
import { adaptiveWrapRows } from "#src/render/wrap.ts";
import { FALLBACK_PALETTE } from "#src/theme/palette.ts";
import { plain } from "#test/fixtures.ts";

/**
 * The suite's view caller: the fixed frame (no language, the fallback
 * palette, the bar indicator) with only the per-test knobs explicit.
 *
 * @param view - Which diff view to render (split or unified).
 * @param diff - The parsed diff.
 * @param options - Optional knobs (maxLines, width) over the defaults.
 * @returns The rendered view.
 */
async function renderView(
  view: typeof renderSplit | typeof renderUnified,
  diff: ParsedDiff,
  options: { maxLines?: number; width?: number } = {},
): Promise<string> {
  const { maxLines = 40, width = 80 } = options;
  return view({
    diff,
    language: undefined,
    maxLines,
    width,
    palette: FALLBACK_PALETTE,
    indicator: "bar",
  });
}

describe("lineNumberWidth (gutter sizing authority)", () => {
  it("sizes to the visible window, not the whole diff", () => {
    // 5 lines visible with small numbers; line 10000 far below the window.
    const lines = [
      { type: "ctx", oldNum: 1, newNum: 1, content: "a" },
      { type: "add", oldNum: null, newNum: 2, content: "b" },
      { type: "ctx", oldNum: 3, newNum: 3, content: "c" },
      { type: "ctx", oldNum: 4, newNum: 4, content: "d" },
      { type: "ctx", oldNum: 5, newNum: 5, content: "e" },
      { type: "ctx", oldNum: 10000, newNum: 10000, content: "hidden" },
    ] satisfies DiffLine[];
    expect(lineNumberWidth(lines, 5)).toBe(2); // max visible is 5; floor of 2 applies
    expect(lineNumberWidth(lines, 6)).toBe(5); // window includes 10000
    expect(lineNumberWidth(lines, 0)).toBe(2); // empty window: floor of 2
  });
});

describe("renderUnified", () => {
  it("renders between-hunk separator labels for multi-hunk edit patches", async () => {
    const patch = [
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -21,2 +21,2 @@",
      " x",
      "-y",
      "+Y",
    ].join("\n");
    const diffs = parsePatchFiles(patch);
    const out = await renderView(renderUnified, diffs[0]);
    expect(plain(out)).toContain("+17 lines");
  });

  it("renders add-only diffs (no del lines anywhere — split is impossible)", async () => {
    const diff = parseDiff("", "alpha\nbeta\n");
    const out = await renderView(renderUnified, diff);
    const lines = plain(out).split("\n");
    expect(lines.some((l) => l.includes("+") && l.includes("alpha"))).toBe(true);
    expect(lines.some((l) => l.includes("+") && l.includes("beta"))).toBe(true);
    // Every visible row stays within the render width.
    for (const row of out.split("\n")) {
      expect(plain(row).length).toBeLessThanOrEqual(80);
    }
  });

  it("renders del-only diffs", async () => {
    const diff = parseDiff("alpha\nbeta\n", "");
    const out = await renderView(renderUnified, diff);
    const text = plain(out);
    expect(text).toContain("alpha");
    expect(text).toContain("-");
  });

  it("emits hunk separators with skipped-line counts across hunks", async () => {
    const old = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const next = old.replace("line 5\n", "line five\n").replace("line 30\n", "line thirty\n");
    const diff = parseDiff(old, next, 2);
    const out = await renderView(renderUnified, diff, { maxLines: 60 });
    const text = plain(out);
    // Two separate hunks → a between-hunk separator with a skip count.
    expect(text).toMatch(/\+2\d? lines|— \+\d+ lines/);
    expect(text).toContain("line five");
    expect(text).toContain("line thirty");
  });

  it("truncates with a more-lines footer past the visible window", async () => {
    const diff = parseDiff("a\n", "b\n".repeat(60), 3);
    const out = await renderView(renderUnified, diff, { maxLines: 10 });
    expect(plain(out)).toContain("more lines");
  });

  it("word emphasis covers exactly the changed word — no bleed into indentation", async () => {
    const diff = parseDiff("\toldValue = 1;\n", "\tnewValue = 1;\n", 0);
    const out = await renderView(renderUnified, diff, { maxLines: 10 });
    // Cell-level walk of the final ANSI rows: collect the visible chars
    // under each word background, then assert the changed words carry
    // them EXACTLY — the tab (jsdiff merges it into the changed chunk,
    // and the renderer expands it to two columns) must stay out.
    const bgClasses = [
      FALLBACK_PALETTE.bgRemovedWord,
      FALLBACK_PALETTE.bgAddedWord,
      FALLBACK_PALETTE.bgRemoved,
      FALLBACK_PALETTE.bgAdded,
      FALLBACK_PALETTE.bgBase,
    ];
    const spanOf = (bg: string): string => {
      let chars = "";
      let on = false;
      for (const row of out.split("\n")) {
        for (const cell of iterateCells(row)) {
          if (cell.escape) {
            if (cell.text === bg) on = true;
            else if (bgClasses.includes(cell.text)) on = false;
            continue;
          }
          if (on) chars += cell.text;
        }
      }
      return chars;
    };
    expect(spanOf(FALLBACK_PALETTE.bgRemovedWord)).toBe("oldValue");
    expect(spanOf(FALLBACK_PALETTE.bgAddedWord)).toBe("newValue");
  });

  it("returns an empty string for an empty diff", async () => {
    const out = await renderView(
      renderUnified,
      { lines: [], added: 0, removed: 0 },
      {
        maxLines: 10,
      },
    );
    expect(out).toBe("");
  });

  it("word-emphasizes paired lines through the plain path when highlighting is off", async () => {
    // One paired change with undefined language: canHighlight is true, so the
    // injectBg path runs — the plain path needs the char budget exceeded.
    const diff = parseDiff("const greeting = 'hello';\n", "const greeting = 'world';\n");
    const out = await renderView(renderUnified, diff, { maxLines: 20 });
    const text = plain(out);
    expect(text).toContain("hello");
    expect(text).toContain("world");
    // Paired del/add rows both render.
    expect(text).toContain("-");
    expect(text).toContain("+");
  });

  it("uses plainWordDiff for paired lines when the source exceeds the highlight budget", async () => {
    // Bulk filler in CONTEXT lines (short rows) pushes sourceChars past the
    // 80k budget, so the paired change renders through plainWordDiff.
    const filler = Array.from({ length: 1400 }, (_, i) => `ctx ${i}`).join("\n");
    const old = `${filler}\nconst v = 'a';\n`;
    const next = `${filler}\nconst v = 'b';\n`;
    const diff = parseDiff(old, next, 2);
    const out = await renderView(renderUnified, diff, { maxLines: 60 });
    const text = plain(out);
    expect(text).toContain("const v = 'a';");
    expect(text).toContain("const v = 'b';");
  });
});

describe("borderBar / adaptiveWrapRows", () => {
  it("bar indicator renders the marker; none collapses the column entirely", () => {
    expect(borderBar("bar")).toBe("▌");
    expect(borderBar("none")).toBe("");
  });

  it("wrap budgets grow with terminal width", () => {
    const narrow = adaptiveWrapRows(60);
    const medium = adaptiveWrapRows(130);
    const wide = adaptiveWrapRows(200);
    expect(narrow).toBeLessThan(medium);
    expect(medium).toBeLessThanOrEqual(wide);
  });
});

describe("header helpers", () => {
  it("summarize builds the +N -M chip and the no-change fallback", () => {
    expect(plain(summarize(3, 5, FALLBACK_PALETTE))).toBe("+3 -5");
    expect(plain(summarize(2, 0, FALLBACK_PALETTE))).toBe("+2");
    expect(plain(summarize(0, 4, FALLBACK_PALETTE))).toBe("-4");
    expect(plain(summarize(0, 0, FALLBACK_PALETTE))).toBe("no changes");
  });

  it("chips close with the bare reset — no background re-open tail", () => {
    // The header row's background is injected (injectBg re-opens its
    // baseBg after every reset) — the chip must NOT re-open the palette's
    // bgBase itself, or that stale escape would overpaint the row tail
    // (the mechanism behind the theme-switch stale-chip report).
    for (const chip of [summarize(3, 5, FALLBACK_PALETTE), summarize(0, 0, FALLBACK_PALETTE)]) {
      expect(chip).toContain("\x1b[0m");
      // eslint-disable-next-line no-control-regex -- matches the SGR bg escapes the chip must not emit
      expect(chip).not.toMatch(/\x1b\[4[89]/);
    }
  });

  it("formatToolErrorResult windows the body collapsed, shows everything expanded", () => {
    const theme = {
      fg: (name: string, text: string) => `[${name}]${text}`,
      bold: (text: string) => `*${text}*`,
      getBgAnsi: () => "",
      getFgAnsi: () => "",
    } as never;
    // 20 lines: the collapsed window shows 10 + the expand hint.
    const long = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    const collapsed = formatToolErrorResult({
      name: "edit",
      message: long,
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    const text = plain(collapsed);
    // Non-shell frames render the body alone (the call header above
    // already names the tool) — no tool-name row here.
    expect(text.split("\n").filter((r) => /^\s*(← )?edit\b/.test(r))).toEqual([]);
    expect(text).toContain("line-9"); // the window's last line
    expect(text).not.toContain("line-10"); // beyond the window
    expect(text).toContain("10 more lines");
    expect(text).toContain("to expand");
    // Expanded: every line, no hint.
    const expanded = formatToolErrorResult({
      name: "edit",
      message: long,
      theme,
      pathShortener: (p: string) => p,
      expanded: true,
      indicatorStyle: "bar",
      width: 120,
    });
    const full = plain(expanded);
    expect(full).toContain("line-19");
    expect(full).not.toContain("more lines");
  });

  it("formatToolErrorResult renders the body alone for file tools (the call header above already names the tool + path)", () => {
    const theme = {
      fg: (name: string, text: string) => `[${name}]${text}`,
      bold: (text: string) => `*${text}*`,
      getBgAnsi: () => "",
      getFgAnsi: () => "",
    } as never;
    const out = formatToolErrorResult({
      name: "edit",
      message: "Could not find the exact text",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    const rows = plain(out).split("\n");
    // NO header row: nothing leads with the tool name (the call header
    // above the frame already shows `← edit path` — a second header row
    // is the double-header bug).
    expect(rows.filter((r) => /^\s*(← )?edit\b/.test(r))).toEqual([]);
    // The body's single row carries the bar and the message (the fake
    // theme's fg wraps segments in [name] brackets — plain cannot strip
    // those, so match on the meaningful content, not exact equality).
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("▌ ");
    expect(rows[0]).toContain("Could not find the exact text");
  });

  it("setToolErrorBg uses the theme's error background with a palette fallback", () => {
    const painters: Array<((line: string) => string) | undefined> = [];
    const text = {
      setText(_s: string) {},
      render: (_w: number): string[] => [""],
      invalidate() {},
      setCustomBgFn(fn?: (line: string) => string) {
        painters.push(fn);
      },
      previewTask: undefined,
      customBgFn: undefined,
    };
    // Theme WITH an error background.
    setToolErrorBg(
      text as never,
      {
        fg: () => "",
        getBgAnsi: (name: string) => (name === "toolErrorBg" ? "\x1b[48;2;9;9;9m" : ""),
      } as never,
      FALLBACK_PALETTE,
    );
    // Theme WITHOUT one (throws or returns undefined) falls back to background.
    setToolErrorBg(
      text as never,
      {
        fg: () => "",
        getBgAnsi: () => undefined,
      } as never,
      FALLBACK_PALETTE,
    );
    setToolErrorBg(
      text as never,
      {
        fg: () => "",
        getBgAnsi: () => {
          throw new Error("no bg");
        },
      } as never,
      FALLBACK_PALETTE,
    );
    expect(painters).toHaveLength(3);
    // Each painter actually paints: the themed one opens the theme's
    // error background; the fallbacks open the palette's base.
    const [themed, missing, throwing] = painters as [
      (line: string) => string,
      (line: string) => string,
      (line: string) => string,
    ];
    expect(themed("x")).toContain("\x1b[48;2;9;9;9m");
    expect(missing("x")).toContain(FALLBACK_PALETTE.bgBase);
    expect(throwing("x")).toContain(FALLBACK_PALETTE.bgBase);
  });

  it("rejects narrow widths", () => {
    const diff = parseDiff("const a = 1;\n", "const b = 2;\n");
    expect(shouldUseSplit(diff, 30, 40)).toBe(false);
  });

  it("accepts a balanced single-line pair at a comfortable width", () => {
    const diff = parseDiff("const a = 1;\n", "const b = 2;\n");
    expect(shouldUseSplit(diff, 120, 40)).toBe(true);
  });

  it("shouldUseSplit rejects add-only diffs; renderSplit renders whatever it is given", async () => {
    const diff = parseDiff("", "alpha\nbeta\n");
    // The choice lives in the caller (renderPaddedDiff); the view itself is
    // a pure renderer with no fallback branch.
    expect(shouldUseSplit(diff, 120, 40)).toBe(false);
    const out = await renderView(renderSplit, diff, { width: 120 });
    expect(out).not.toBe("");
  });
});
