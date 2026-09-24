/**
 * The wrap primitives: ANSI-aware wrapping to an exact column width with a
 * per-width-class row budget. Both diff views wrap every row through
 * `wrapAnsi` — the split view places its right column right after the
 * left, so unpadded rows would misalign the halves (every row occupies
 * EXACTLY the target width).
 */

import { continuationTail, forEachCell, isPlainAscii, truncateBudget } from "#src/core/ansi.ts";
import { SgrState } from "#src/core/sgr.ts";
import type { ResolvedTheme } from "#src/theme/scheme.ts";

/** Row budget for one wrapping line on wide terminals (≥180 columns). */
const MAX_WRAP_ROWS_WIDE = 3;
/** Row budget for one wrapping line on medium terminals (≥120 columns). */
const MAX_WRAP_ROWS_MED = 2;
/** Row budget for one wrapping line on narrow terminals (below 120 columns). */
const MAX_WRAP_ROWS_NARROW = 1;

/**
 * Max rows a wrapping line may occupy, by terminal width class: wide
 * terminals wrap more, narrow ones truncate sooner.
 *
 * @param width - Render width in columns.
 * @returns The row budget for one wrapped line.
 */
export function adaptiveWrapRows(width: number): number {
  if (width >= 180) return MAX_WRAP_ROWS_WIDE;
  if (width >= 120) return MAX_WRAP_ROWS_MED;
  return MAX_WRAP_ROWS_NARROW;
}

/** The wrapAnsi inputs. */
export interface WrapAnsiOptions {
  /** Target column width. */
  width: number;
  /** Row budget (from adaptiveWrapRows). */
  maxRows: number;
  /** Background escape padding each row. */
  fillBg: string;
  /** The resolved scheme (rowReset re-opens rows). */
  scheme: ResolvedTheme;
}

/**
 * The fits gate only runs at this pane width and above. Below it most
 * code lines overflow (the mixed-frame bench asserts the real fits share
 * per pane in tests/bench-fixtures.ts), so the measurement walk is pure
 * overhead — the gate's break-even sits between the 36/40-column panes
 * (losing) and the 44-column pane (winning); see the mixed-frame bench.
 */
const FITS_GATE_MIN_WIDTH = 44;

/**
 * The columns `content` occupies when it fits within `width`, or -1 when it
 * overflows (the walk stops at the cell that would overshoot).
 *
 * Escape cells are skipped in place by the same grammar `wrapAnsi` walks,
 * which is what makes the fits verdict byte-safe: no cell can exceed the
 * budget, so no row break — and no tracker traffic — can have happened.
 *
 * @param content - ANSI-styled text.
 * @param width - The column budget.
 * @returns The used columns, or -1 when the content overflows.
 */
function fitsWithin(content: string, width: number): number {
  let cols = 0;
  let fits = true;
  forEachCell(content, (_start, _end, cellCols) => {
    cols += cellCols;
    if (cols > width) {
      fits = false;
      return true;
    }
    return;
  });
  return fits ? cols : -1;
}

/**
 * Wrap ANSI content to `width` columns, capping at `maxRows` (the last row
 * shows a continuation marker when truncated). Escape sequences carry no
 * visual width; a carried SGR state re-opens on each row so styling survives
 * the break. Every returned row occupies EXACTLY `width` columns (padded
 * with `fillBg` spaces) — the split view places its right column right
 * after the left, so unpadded rows would misalign the halves.
 *
 * @param content - ANSI-styled text.
 * @param options - The wrap inputs.
 * @returns The wrapped rows.
 */
export function wrapAnsi(content: string, options: WrapAnsiOptions): string[] {
  const { width, maxRows, fillBg, scheme } = options;
  if (width <= 0) return [""];
  // Plain fast path: pure printable ASCII needs no cell walk — one column
  // per code unit, so the fits gate and the wrapping both reduce to length
  // arithmetic and slicing. (A length-only gate must NOT decide for styled
  // or CJK content: wide code points count two columns, so a CJK line can
  // fit the code-unit budget while overflowing visually.)
  if (isPlainAscii(content)) {
    if (content.length <= width) {
      return [content + fillBg + " ".repeat(width - content.length) + scheme.rowReset];
    }
    return wrapPlainAscii(content, width, maxRows, fillBg, scheme);
  }
  // Non-plain content (escapes, CJK): a measure-only walk decides the fits
  // case up front — a fitting line takes one allocation-free walk plus one
  // pad instead of the full wrap machinery. An overflowing line pays the
  // measurement again, but it stops at the cell that overshoots, so the
  // repeated pass is only as long as the first row.
  const used = width >= FITS_GATE_MIN_WIDTH ? fitsWithin(content, width) : -1;
  if (used !== -1) {
    return [content + fillBg + " ".repeat(width - used) + scheme.rowReset];
  }
  // Row bytes are materialized LAZILY — a row is a contiguous slice of
  // `content` (its escapes ride inside the slice), so only a real break
  // (`breakRow`) or the truncation emit slices; the final row slices once.
  const rows: string[] = [];
  let rowStart = 0; // Where the open row's content begins in `content`.
  let prefix = ""; // The carried state seeded onto a continuation row ("" on row 1).
  let rowCols = 0;
  let onLastRow = false;
  let effectiveWidth = width;
  // The initial last-row arm, hoisted out of the per-cell callback: rows.length
  // starts at 0, so only a budget of 1 can arm it before the first cell.
  if (maxRows <= 1) {
    onLastRow = true;
    effectiveWidth = truncateBudget(width);
  }
  const tracker = new SgrState();
  /**
   * Close the row spanning [rowStart, breakStart): pad to EXACT width and
   * open the next.
   *
   * @param breakStart - One past the row's last code unit.
   */
  const breakRow = (breakStart: number): void => {
    const state = tracker.replay();
    rows.push(
      prefix +
        content.slice(rowStart, breakStart) +
        fillBg +
        // Load-bearing: the cell that triggered the break stays on the NEXT
        // row, so a cell wider than the row (2 cols at width 1) overdraws.
        " ".repeat(Math.max(0, width - rowCols)) +
        scheme.rowReset,
    );
    prefix = state + fillBg;
    // The `!== ""` guard is correctness, not micro-optimization: apply("")
    // parses an empty body as the `0` default and CLEARS the state (the
    // replay above is what re-seeds it; applying `state` is a no-op).
    if (fillBg !== "") tracker.apply(fillBg, 0, fillBg.length);
    rowStart = breakStart;
    rowCols = 0;
    if (rows.length >= maxRows - 1) {
      onLastRow = true;
      effectiveWidth = truncateBudget(width);
    }
  };
  let truncated = false;
  forEachCell(content, (start, end, cols, isEscape) => {
    if (isEscape) {
      // Only SGR cells reach the tracker — escapeEndAt also recognizes OSC
      // (the header's hyperlinks), whose payload is not parameters.
      if (content[start + 1] === "[") tracker.apply(content, start, end);
      return;
    }
    if (rowCols + cols > effectiveWidth) {
      if (onLastRow) {
        // THIS discarded cell proves visible content remains (escapes never
        // reach the width check), so the marker is gated only by room to
        // draw it; the row stays at exactly width columns.
        const rowContent = content.slice(rowStart, start);
        rows.push(
          prefix +
            rowContent +
            fillBg +
            " ".repeat(Math.max(0, effectiveWidth - rowCols)) +
            scheme.rowReset +
            (width > 2 ? continuationTail(scheme.rowReset, scheme.fgDim) : ""),
        );
        truncated = true;
        return true;
      }
      breakRow(start);
    }
    rowCols += cols;
  });
  if (truncated) return rows;
  // No guard needed: the walk only runs for non-plain content, and "" is
  // plain — so a final row always exists to push.
  rows.push(
    prefix +
      content.slice(rowStart) +
      fillBg +
      " ".repeat(Math.max(0, width - rowCols)) +
      scheme.rowReset,
  );
  return rows;
}

/**
 * Wrap pure printable-ASCII content without the cell walk — the walk's
 * byte contract replicated by slicing. Rows break at exactly `width`
 * columns; the first row opens bare, the second with one `fillBg`, and
 * rows beyond it with two (the carried background re-open plus the fresh
 * one); the last row truncates at width-1 with the `›` marker when content
 * remains (width <= 2 has no marker room); every row closes at exactly
 * `width` columns.
 *
 * @param content - Printable ASCII (isPlainAscii held) longer than width.
 * @param width - Target column width (> 0).
 * @param maxRows - Row budget.
 * @param fillBg - Background escape for each row's padding.
 * @param scheme - The resolved scheme (rowReset + fgDim for the marker).
 * @returns The wrapped rows.
 */
function wrapPlainAscii(
  content: string,
  width: number,
  maxRows: number,
  fillBg: string,
  scheme: ResolvedTheme,
): string[] {
  const rows: string[] = [];
  let start = 0;
  // `end` is clamped to start + room, so the pads below are never negative.
  while (start < content.length) {
    const armed = rows.length >= maxRows - 1;
    const room = armed ? truncateBudget(width) : width;
    const end = Math.min(start + room, content.length);
    const slice = content.slice(start, end);
    const open = rows.length === 0 ? "" : rows.length === 1 ? fillBg : `${fillBg}${fillBg}`;
    if (armed && end < content.length) {
      rows.push(
        `${open}${slice}${fillBg}${" ".repeat(room - slice.length)}${scheme.rowReset}${width > 2 ? continuationTail(scheme.rowReset, scheme.fgDim) : ""}`,
      );
      return rows;
    }
    rows.push(`${open}${slice}${fillBg}${" ".repeat(width - slice.length)}${scheme.rowReset}`);
    start = end;
  }
  return rows;
}
