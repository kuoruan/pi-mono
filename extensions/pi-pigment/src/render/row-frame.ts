/**
 * The row frame: the per-line gutter composition (border + line number +
 * sign + backgrounds) both diff views render rows through, plus the
 * gutter-sizing authorities (lineNumberWidth, gutterWidth) the split
 * verdict and write's new-file preview share. The views keep only their
 * genuine variance (pairing, column split, separator styling).
 */

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import type { DiffLine } from "#src/core/diff.ts";
import type { DiffPalette } from "#src/theme/palette.ts";

/**
 * The left-edge change-indicator glyph for `indicator` — the bar
 * marker, or an EMPTY string when disabled (the column collapses
 * entirely; every composer treats "" as no column). The frame Box's
 * own padding is the single leading space rows keep in none mode.
 *
 * @param indicator - Configured indicator style.
 * @returns A single visual column, or "" when the config disables it.
 */
export function borderBar(indicator: IndicatorStyle): string {
  return indicator === "none" ? "" : "▌";
}

/**
 * Render a right-aligned line number in the gutter, or blanks when absent.
 *
 * @param value - The line number (null for unnumbered rows).
 * @param width - Gutter column width.
 * @param palette - The resolved palette (lnum fg + row close).
 * @param fg - Foreground escape for the digits (defaults to fgGutter).
 * @returns The styled gutter cell.
 */
export function lnum(
  value: number | null,
  width: number,
  palette: DiffPalette,
  fg?: string,
): string {
  if (value === null) return " ".repeat(width);
  const text = String(value);
  return `${fg ?? palette.fgGutter}${" ".repeat(Math.max(0, width - text.length))}${text}${palette.rowReset}`;
}

/**
 * The gutter's line-number column width for a diff's VISIBLE window — the
 * single authority both views and the split decision share (a window never
 * needs space for line numbers only truncation hides; all three callers
 * sizing independently once produced different gutter widths for the same
 * diff).
 *
 * @param lines - The diff's lines.
 * @param maxLines - The visible row budget.
 * @returns The line-number column width (at least 2).
 */
export function lineNumberWidth(lines: readonly DiffLine[], maxLines: number): number {
  const visible = lines.slice(0, maxLines);
  // BOTH numbers participate: del rows show oldNum, add/ctx rows show
  // newNum — and a patch-sourced ctx line carries the two sides' numbers
  // independently (old 92 / new 101). Sizing on one side (oldNum ??
  // newNum) under-budgets when the other side's numbers run wider (a
  // 3-digit newNum on a 2-digit budget overflows the gutter one column
  // per row, and the Text wrap pass turns that into phantom blank
  // continuation rows after every such row).
  const max = Math.max(...visible.flatMap((line) => [line.oldNum ?? 0, line.newNum ?? 0]), 0);
  return Math.max(2, String(max).length);
}

/**
 * The gutter's column budget: line-number width + 3 fixed columns
 * (sign, pointer, padding) + the indicator glyph's own width. One
 * authority — the split/unified views and write's new-file preview all
 * budget through it ("none" mode's empty glyph collapses the column).
 *
 * @param numberWidth - The line-number column width.
 * @param indicatorGlyph - The indicator column's rendered glyph.
 * @returns The gutter width in columns.
 */
export function gutterWidth(numberWidth: number, indicatorGlyph: string): number {
  return numberWidth + 3 + indicatorGlyph.length;
}

/** The per-line-type frame facts both views share. */
export interface DiffRowFrame {
  /** The change-sign column color (per line type). */
  signFg: string;
  /** The change sign ("-", "+", or " "). */
  sign: string;
  /** The gutter's background (per line type). */
  gutterBg: string;
  /** The body's background (per line type). */
  codeBg: string;
  /** The left-edge indicator border (the bar — indicatorStyle's only surface). */
  border: string;
  /** The line-number foreground (the sign color on changed lines). */
  numFg: string;
  /** The first row's gutter string (border + number + sign). */
  gutter: string;
  /** The continuation rows' gutter (border + blanks). */
  continuation: string;
}

/** The diffRowFrame inputs. */
export interface DiffRowFrameOptions {
  /** The line's role ("del", "add", or context). */
  type: "del" | "add" | "ctx";
  /** The line number the gutter shows (null: blank cell). */
  number: number | null;
  /** The line-number column width. */
  numberWidth: number;
  /** The resolved palette. */
  palette: DiffPalette;
  /** The indicator column's glyph (borderBar's result). */
  indicatorGlyph: string;
}

/**
 * Compose a diff row's frame — the gutter pieces, backgrounds, and sign
 * colors derived from the line's type. THE single authority for gutter
 * composition (width formula, continuation shape, border selection) that
 * both views render rows through; the views keep only their genuine
 * variance (pairing, column split, separator styling).
 *
 * @param options - The row's frame inputs.
 * @returns The row's frame facts.
 */
export function diffRowFrame(options: DiffRowFrameOptions): DiffRowFrame {
  const { type, number, numberWidth, palette, indicatorGlyph } = options;
  // One dispatch over the row type — every per-type style field flows
  // from this single place.
  const { gutterBg, codeBg, signFg, sign, borderFg } =
    type === "del"
      ? {
          gutterBg: palette.bgRemovedGutter,
          codeBg: palette.bgRemoved,
          signFg: palette.fgRemoved,
          sign: "-",
          borderFg: palette.fgRemoved,
        }
      : type === "add"
        ? {
            gutterBg: palette.bgAddedGutter,
            codeBg: palette.bgAdded,
            signFg: palette.fgAdded,
            sign: "+",
            borderFg: palette.fgAdded,
          }
        : {
            gutterBg: palette.bgBase,
            codeBg: palette.bgBase,
            signFg: palette.fgContext,
            sign: " ",
            borderFg: "",
          };

  const border = !indicatorGlyph
    ? ""
    : borderFg
      ? `${borderFg}${indicatorGlyph}${palette.rowReset}`
      : `${palette.bgBase} `;
  const numFg = borderFg || palette.fgGutter;
  const gutter = `${border}${gutterBg}${lnum(number, numberWidth, palette, numFg)}${gutterBg} ${signFg}${sign}${gutterBg} ${palette.rowReset}`;
  const continuation = `${border}${gutterBg}${" ".repeat(numberWidth + 3)}${palette.rowReset}`;
  return { signFg, sign, gutterBg, codeBg, border, numFg, gutter, continuation };
}
