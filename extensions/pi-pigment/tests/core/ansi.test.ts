import { describe, expect, it } from "vitest";

import {
  ansiState,
  BG_DEFAULT,
  bgRgb,
  expandTabs,
  fgRgb,
  fitAnsi,
  measurePlain,
  mixBg,
  stripAnsi,
} from "#src/core/ansi.ts";
import { wrapAnsi, injectBg, wordDiffAnalysis } from "#src/render/render-shared.ts";
import { FALLBACK_PALETTE } from "#src/theme/palette.ts";

const RED_BG = "\x1b[48;2;255;0;0m";
const GREEN_FG = "\x1b[38;2;0;255;0m";
const RESET = "\x1b[0m";

describe("stripAnsi", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsi(`${RED_BG}text${RESET}`)).toBe("text");
    expect(stripAnsi(`a\x1b[1mb\x1b[22mc`)).toBe("abc");
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("expandTabs", () => {
  it("replaces tabs with two spaces", () => {
    expect(expandTabs("\ta\tb")).toBe("  a  b");
  });
});

describe("mixBg", () => {
  it("blends accent into base by intensity", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(mixBg(black, white, 0)).toBe("\x1b[48;2;0;0;0m");
    expect(mixBg(black, white, 1)).toBe("\x1b[48;2;255;255;255m");
    expect(mixBg(black, white, 0.5)).toBe("\x1b[48;2;128;128;128m");
  });
});

describe("fitAnsi", () => {
  it("pads short content to the width", () => {
    expect(fitAnsi("ab", 5, RESET, "")).toBe("ab   ");
  });

  it("keeps escape sequences out of the visual count", () => {
    const fitted = fitAnsi(`${GREEN_FG}abcdef${RESET}`, 3, RESET, "");
    expect(stripAnsi(fitted)).toBe("ab›");
  });

  it("truncates without a marker when width is tiny", () => {
    expect(stripAnsi(fitAnsi("abcdef", 2, RESET, ""))).toBe("ab");
  });

  it("returns empty for non-positive width", () => {
    expect(fitAnsi("abc", 0, RESET, "")).toBe("");
  });

  it("keeps CJK truncation at exactly the width (no wide-char overshoot)", () => {
    // Regression: the truncation loop once stopped on columns >= showWidth
    // AFTER consuming a wide char, emitting 7 visible columns for width 6.
    const fitted = fitAnsi("中中中b", 6, RESET, "");
    expect(measurePlain(stripAnsi(fitted))).toBe(6);
    // The third wide char is left out and the gap padded: exactly 6 columns.
    expect(stripAnsi(fitted)).toBe("中中 ›");
  });

  it("keeps CJK truncation exact at a two-column boundary", () => {
    // Width 5: budget 4 content columns -> two CJK chars + marker = 5.
    const fitted = fitAnsi("中中中", 5, RESET, "");
    expect(measurePlain(stripAnsi(fitted))).toBe(5);
  });
});

describe("ansiState", () => {
  it("extracts the last active fg and bg", () => {
    expect(ansiState(`${RED_BG}${GREEN_FG}x`)).toBe(`${RED_BG}${GREEN_FG}`);
  });

  it("resets on SGR 0 and default fg on 39", () => {
    expect(ansiState(`${GREEN_FG}a${RESET}b`)).toBe("");
  });

  it("carries open font attributes (bold/italic survive the line break)", () => {
    const BOLD = "\u001b[1m";
    const ITALIC = "\u001b[3m";
    const UNDO = "\u001b[22m\u001b[23m";
    // A bold+italic token broken by a wrap keeps both attributes.
    expect(ansiState(`${BOLD}${ITALIC}${GREEN_FG}partial`)).toBe(`${GREEN_FG}${BOLD}${ITALIC}`);
    // Attribute-off codes clear what they close (fg stays).
    expect(ansiState(`${BOLD}${GREEN_FG}x${UNDO}`)).toBe(`${GREEN_FG}`);
    // A full reset clears attributes too.
    expect(ansiState(`${BOLD}${GREEN_FG}x${RESET}`)).toBe("");
    // `ESC[m` (empty params) is a reset.
    expect(ansiState(`${BOLD}x\u001b[m`)).toBe("");
    // Composite sequences parse per-parameter: bold + truecolor fg in one.
    expect(ansiState("\u001b[1;38;2;10;20;30mx")).toBe("\u001b[38;2;10;20;30m\u001b[1m");
    // 256-color specs consume their tail.
    expect(ansiState("\u001b[38;5;220mx")).toBe("\u001b[38;5;220m");
  });

  it("re-opens carried state so wrapped tokens keep their style", () => {
    const BOLD = "\u001b[1m";
    const state = ansiState(`${BOLD}${GREEN_FG}partial`);
    // The wrap continuation begins with the state; the token stays bold.
    expect(state.startsWith(`${GREEN_FG}`)).toBe(true);
    expect(state).toContain(BOLD);
  });
});

describe("module constants", () => {
  it("BG_DEFAULT resets the background", () => {
    expect(BG_DEFAULT).toBe("\x1b[49m");
  });
});

describe("escape construction via ansis (forced truecolor)", () => {
  it("builds truecolor escapes regardless of ambient color settings", () => {
    // The renderers' output must not adapt to NO_COLOR/FORCE_COLOR: the pi
    // TUI owns color-level degradation, our escapes are the final contract.
    expect(fgRgb({ r: 100, g: 180, b: 120 })).toBe("\u001b[38;2;100;180;120m");
    expect(bgRgb({ r: 30, g: 52, b: 40 })).toBe("\u001b[48;2;30;52;40m");
  });

  it("mixBg routes through the same escape factory", () => {
    expect(mixBg({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)).toBe(
      "\u001b[48;2;128;128;128m",
    );
  });
});

describe("terminal width measurement (code-point aware)", () => {
  it("measures wide code points as two columns", () => {
    expect(measurePlain("hello")).toBe(5);
    expect(measurePlain("你好")).toBe(4);
    expect(measurePlain("a你b")).toBe(4);
    expect(measurePlain("🎉")).toBe(2);
  });

  it("skips SGR escapes when measuring", () => {
    expect(measurePlain("\u001b[38;2;1;2;3mabc\u001b[0m")).toBe(3);
    expect(measurePlain("\u001b[31m你好\u001b[0m")).toBe(4);
  });

  it("fits CJK content without splitting surrogate pairs", () => {
    // Truncation lands on a code-point boundary; the marker follows.
    const fitted = fitAnsi("你好世界", 5, "\u001b[0m", "\u001b[2m");
    expect(fitted).toBe("你好\u001b[0m\u001b[2m›\u001b[0m");
    // Short content pads by columns, not code units.
    expect(fitAnsi("你好", 8, "", "")).toBe("你好    ");
  });
});

describe("wrapAnsi wide-character (CJK) columns", () => {
  // Regression: the fast path once gated on UTF-16 length, so a wide-only
  // line under the unit budget but over the column budget never wrapped.
  it("wraps a CJK line that fits the code-unit budget but exceeds columns", () => {
    // 25 CJK chars = 25 code units but 50 columns; width 40 must wrap.
    const cjk = "汉".repeat(25);
    const rows = wrapAnsi(cjk, { width: 40, maxRows: 10, fillBg: "", palette: FALLBACK_PALETTE });
    expect(rows.length).toBeGreaterThan(1);
    // Every row's visible width is at most 40 columns.
    for (const row of rows) {
      expect(measurePlain(stripAnsi(row))).toBeLessThanOrEqual(40);
    }
  });

  it("breaks before a wide char that would cross the boundary (no 1-column overflow)", () => {
    // 19 CJK chars (38 cols) + "x" — the narrow char fits at column 39.
    // 20 CJK chars (40 cols) + "x" — the x crosses; the row must stop at 40.
    const line = "汉".repeat(20) + "x";
    const rows = wrapAnsi(line, { width: 40, maxRows: 10, fillBg: "", palette: FALLBACK_PALETTE });
    expect(rows[0]).not.toContain("x");
    expect(measurePlain(stripAnsi(rows[0]))).toBeLessThanOrEqual(40);
    expect(rows.length).toBeGreaterThan(1);
  });

  it("pads the truncation-marker row to exactly width columns", () => {
    const fillBg = "\x1b[48;2;10;20;30m";
    // 20 CJK chars = 40 cols, width 8, maxRows 2: the second row truncates
    // with the marker. A wide char can stop the row at width-2; the marker
    // row must still occupy exactly 8 columns.
    const rows = wrapAnsi("汉".repeat(20), {
      width: 8,
      maxRows: 2,
      fillBg,
      palette: FALLBACK_PALETTE,
    });
    const last = rows[rows.length - 1]!;
    expect(measurePlain(stripAnsi(last))).toBe(8);
    // The padding before the marker sits on the row's fill background, not
    // the canvas base.
    expect(last).toContain(fillBg);
    expect(stripAnsi(last).endsWith("›")).toBe(true);
  });

  it("pads an ASCII line to exactly width columns (unified row contract)", () => {
    const reset = "\u001b[0m";
    // Every row occupies exactly `width` columns and closes with reset —
    // the split view butts its right half against the left, so rows must
    // never under- or over-flow their column budget.
    expect(
      wrapAnsi("hello", { width: 8, maxRows: 3, fillBg: "", palette: FALLBACK_PALETTE }),
    ).toEqual([`hello   ${reset}`]);
    expect(
      wrapAnsi("exactfit", { width: 8, maxRows: 3, fillBg: "", palette: FALLBACK_PALETTE }),
    ).toEqual([`exactfit${reset}`]);
  });
});

describe("injectBg / wordDiffAnalysis code-point alignment", () => {
  it("emphasizes the changed word even when CJK chars precede it", () => {
    const oldText = "你好世界 value";
    const newText = "你好世界 valor";
    const { oldRanges, newRanges } = wordDiffAnalysis(oldText, newText);
    // The changed word starts after 4 CJK chars + space = 5 code points.
    expect(oldRanges).toEqual([[5, 10]]);
    expect(newRanges).toEqual([[5, 10]]);
    // injectBg advances one per code point, so the highlight lands on the
    // changed word — right after the 4 CJK chars + space — not 4 columns
    // early (the old column-counted matching started the emphasis on "界").
    const base = "\x1b[48;2;0;0;0m";
    const hi = "\x1b[48;2;1;1;1m";
    const out = injectBg("你好世界 value", {
      ranges: [[5, 10]],
      baseBg: base,
      highlightBg: hi,
      palette: FALLBACK_PALETTE,
    });
    expect(out.startsWith(`${base}你好世界 `)).toBe(true);
    expect(out).toContain(`${hi}value`);
  });

  it("measurePlain's ASCII fast path agrees with the cell walk", () => {
    // Same answer both ways for: plain ASCII, empty, spaces-only.
    for (const s of ["", "   ", "const x = 1;", "a".repeat(500)]) {
      expect(measurePlain(s)).toBe(s.length);
    }
    // Non-ASCII falls to the precise walk (CJK = 2 cols, escapes = 0).
    expect(measurePlain("\u4e2d\u6587")).toBe(4);
    expect(measurePlain("\x1b[38;2;1;2;3mabc\x1b[39m")).toBe(3);
    expect(measurePlain("\u00e9")).toBe(1); // é: one column, two code units? no — BMP, 1 col
  });
});
