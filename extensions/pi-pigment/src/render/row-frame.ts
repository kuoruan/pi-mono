/**
 * The row frame: the per-line gutter composition (border + line number +
 * sign + backgrounds) both diff views render rows through, plus the
 * gutter-sizing authorities (lineNumberWidth, gutterWidth) the split
 * verdict and write's new-file preview share. The views keep only their
 * genuine variance (pairing, column split, separator styling).
 */

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import type { DiffLine } from "#src/core/diff.ts";
import type { ResolvedTheme } from "#src/theme/scheme.ts";

import { injectBg } from "./inject-bg.ts";
import { wrapAnsi } from "./wrap.ts";

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
 * @param scheme - The resolved scheme (lnum fg + row close).
 * @param fg - Foreground escape for the digits (defaults to fgGutter).
 * @returns The styled gutter cell.
 */
export function lnum(
  value: number | null,
  width: number,
  scheme: ResolvedTheme,
  fg?: string,
): string {
  if (value === null) return " ".repeat(width);
  const text = String(value);
  return `${fg ?? scheme.fgGutter}${" ".repeat(Math.max(0, width - text.length))}${text}${scheme.rowReset}`;
}

/**
 * The gutter's line-number column width for the UNIFIED view's visible
 * window — the lines slice IS the truth there (visible rows show the
 * slice's own numbers, no far-away pairing). The split view sizes
 * independently from its visible ROWS (a paired row displays a del
 * line AND its far-away add partner, whose numbers can sit well past
 * any line-prefix window) — see renderSplit. The two callers sizing
 * through one helper once produced different gutter widths for the
 * same diff; the split is deliberate, not drift.
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

/** The per-line-type frame facts the views share. */
export interface RowFrame {
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

/** The rowFrame inputs. */
export interface RowFrameOptions {
  /** The line's role ("del"/"add"/"ctx" for diffs, "read" for the file-read body). */
  type: "del" | "add" | "ctx" | "read";
  /** The line number the gutter shows (null: blank cell). */
  number: number | null;
  /** The line-number column width. */
  numberWidth: number;
  /** The resolved scheme. */
  scheme: ResolvedTheme;
  /** The indicator column's glyph (borderBar's result). */
  indicatorGlyph: string;
}

/** The per-type style fields rowFrame dispatches (the sign/border colors and glyphs). */
interface RowStyle {
  /** The gutter's background. */
  gutterBg: string;
  /** The body's background. */
  codeBg: string;
  /** The change-sign color ("" when the type carries no sign). */
  signFg: string;
  /** The change sign ("" collapses the column — read rows). */
  sign: string;
  /** The bar color ("" renders the bar on the base surface). */
  borderFg: string;
}

/**
 * The row type's style fields — the switch rowFrame dispatches
 * through, so a new type adds one case instead of renesting a ternary.
 *
 * @param type - The line's role.
 * @param scheme - The resolved scheme.
 * @returns The type's style fields.
 */
function rowStyle(type: RowFrameOptions["type"], scheme: ResolvedTheme): RowStyle {
  switch (type) {
    case "del":
      return {
        gutterBg: scheme.bgRemovedGutter,
        codeBg: scheme.bgRemoved,
        signFg: scheme.fgRemoved,
        sign: "-",
        borderFg: scheme.fgRemoved,
      };
    case "add":
      return {
        gutterBg: scheme.bgAddedGutter,
        codeBg: scheme.bgAdded,
        signFg: scheme.fgAdded,
        sign: "+",
        borderFg: scheme.fgAdded,
      };
    case "ctx":
      return {
        gutterBg: scheme.bgBase,
        codeBg: scheme.bgBase,
        signFg: scheme.fgContext,
        sign: " ",
        borderFg: "",
      };
    case "read":
      return {
        gutterBg: scheme.bgBase,
        codeBg: scheme.bgBase,
        signFg: "",
        sign: "",
        borderFg: "",
      };
  }
}

/** The numberedRows inputs. */
export interface NumberedRowsOptions {
  /** The highlighted lines. */
  lines: readonly string[];
  /** The resolved scheme. */
  scheme: ResolvedTheme;
  /** The row type ("read" for file reads, "add" for new-file previews). */
  type: "read" | "add";
  /** The 1-indexed first line number. */
  startLine: number;
  /** The gutter's visual width (the code width budgets against it). */
  gutter: number;
  /** The bar glyph (borderBar's result; read rows pass ""). */
  indicatorGlyph: string;
  /** The render width. */
  width: number;
}

/**
 * Paint numbered rows: the shared assembly read/write bodies render
 * highlighted lines through — rowFrame for the gutter, injectBg for
 * the row wash, wrapAnsi for width-aware continuation rows repeating
 * the gutter shape. The callers supply only their genuine variance
 * (the row type, the numbering rule, the gutter's code width).
 *
 * @param options - The rows' inputs (see NumberedRowsOptions).
 * @returns The guttered, wrapped rows.
 */
export function numberedRows(options: NumberedRowsOptions): string[] {
  const { lines, scheme, type, startLine, gutter, indicatorGlyph, width } = options;
  const numberWidth = Math.max(2, String(startLine + lines.length - 1).length);
  const codeWidth = Math.max(20, width - gutter);
  return lines.flatMap((line, i) => {
    const frame = rowFrame({ type, number: startLine + i, numberWidth, scheme, indicatorGlyph });
    // Unlimited wrap budget: a preview must show its content (the
    // diff views' narrow-terminal row cap truncates overlong lines
    // behind a › marker).
    const wrapped = wrapAnsi(injectBg(line, { baseBg: frame.codeBg, scheme }), {
      width: codeWidth,
      maxRows: Number.POSITIVE_INFINITY,
      fillBg: frame.codeBg,
      scheme,
    });
    const rows = [`${frame.gutter}${wrapped[0]}${scheme.rowReset}`];
    for (let rowIndex = 1; rowIndex < wrapped.length; rowIndex++) {
      rows.push(`${frame.continuation}${wrapped[rowIndex]}${scheme.rowReset}`);
    }
    return rows;
  });
}

/**
 * Compose a row's frame — the gutter pieces, backgrounds, and sign
 * colors derived from the line's type. THE single authority for gutter
 * composition (width formula, continuation shape, border selection) the
 * diff views AND the read body render rows through; the callers keep
 * only their genuine variance (pairing, column split, separator
 * styling).
 *
 * @param options - The row's frame inputs.
 * @returns The row's frame facts.
 */
export function rowFrame(options: RowFrameOptions): RowFrame {
  const { type, number, numberWidth, scheme, indicatorGlyph } = options;
  // One dispatch over the row type — every per-type style field flows
  // from this single place.
  const style = rowStyle(type, scheme);
  const { gutterBg, codeBg, signFg, sign, borderFg } = style;

  const border = !indicatorGlyph
    ? ""
    : borderFg
      ? `${borderFg}${indicatorGlyph}${scheme.rowReset}`
      : `${scheme.bgBase} `;
  const numFg = borderFg || scheme.fgGutter;
  // An empty sign collapses its column (read rows carry no sign) —
  // diffs always fill it, so their alignment never shifts. The
  // continuation mirrors the gutter's blank shape exactly.
  const signCell = sign ? ` ${signFg}${sign}${gutterBg} ` : " ";
  const gutter = `${border}${gutterBg}${lnum(number, numberWidth, scheme, numFg)}${gutterBg}${signCell}${scheme.rowReset}`;
  const blanks = " ".repeat(numberWidth + (sign ? 3 : 1));
  const continuation = `${border}${gutterBg}${blanks}${scheme.rowReset}`;
  return { signFg, sign, gutterBg, codeBg, border, numFg, gutter, continuation };
}
