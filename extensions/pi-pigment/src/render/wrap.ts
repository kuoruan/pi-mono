/**
 * The wrap primitives: ANSI-aware wrapping to an exact column width with a
 * per-width-class row budget. Both diff views wrap every row through
 * `wrapAnsi` — the split view places its right column right after the
 * left, so unpadded rows would misalign the halves (every row occupies
 * EXACTLY the target width).
 */

import { continuationTail, forEachCell, isPlainAscii, truncateBudget } from "#src/core/ansi.ts";
import { SgrState } from "#src/core/sgr.ts";
import type { DiffPalette } from "#src/theme/palette.ts";

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
  /** The resolved palette (rowReset re-opens rows). */
  palette: DiffPalette;
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
  const { width, maxRows, fillBg, palette } = options;
  if (width <= 0) return [""];
  // Plain fast path: pure printable ASCII needs no cell walk — one column
  // per code unit, so the fits gate and the wrapping both reduce to length
  // arithmetic and slicing. (A length-only gate must NOT decide for styled
  // or CJK content: wide code points count two columns, so a CJK line can
  // fit the code-unit budget while overflowing visually.)
  if (isPlainAscii(content)) {
    if (content.length <= width) {
      return [content + fillBg + " ".repeat(width - content.length) + palette.rowReset];
    }
    return wrapPlainAscii(content, width, maxRows, fillBg, palette);
  }
  // Non-plain content (escapes, CJK): the single walk below handles BOTH the
  // fits and the wrap outcome — a fitting line emits one row via the final
  // push, byte-identical to the pad formula above — so there is no separate
  // pre-measure to pay a second walk. Row bytes are materialized LAZILY — a
  // row is a contiguous slice of `content` (its escapes ride inside the
  // slice), so the common "fits on one row" case never pays the per-cell
  // slice/concat; only a real break (`breakRow`) or the truncation emit slices.
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
        palette.rowReset,
    );
    // Only fillBg needs applying: `state` just left the tracker (feeding it
    // back is an idempotent no-op), and applySeq would only re-scan bytes
    // the tracker already holds.
    prefix = state + fillBg;
    if (fillBg !== "") tracker.apply(fillBg);
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
      // Only escapes need their text — the tracker consumes it; the bytes
      // themselves ride inside the open row's slice.
      tracker.apply(content.slice(start, end));
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
            palette.rowReset +
            (width > 2 ? continuationTail(palette.rowReset, palette.fgDim) : ""),
        );
        truncated = true;
        return true;
      }
      breakRow(start);
    }
    rowCols += cols;
  });
  if (truncated) return rows;
  if (content.length > 0 || rows.length === 0) {
    rows.push(
      prefix +
        content.slice(rowStart) +
        fillBg +
        " ".repeat(Math.max(0, width - rowCols)) +
        palette.rowReset,
    );
  }
  return rows;
}

/**
 * Wrap pure printable-ASCII content without the cell walk — the walk's
 * byte contract replicated by slicing: rows break at exactly `width`
 * columns; row 1 opens with `fillBg`, rows 2+ with the carried state
 * (the previous row's fillBg open) plus the fresh `fillBg`; the last row
 * truncates at width-1 with the `›` marker when content remains (width
 * <= 2 has no marker room); every row closes at exactly `width` columns.
 *
 * @param content - Printable ASCII (isPlainAscii held) longer than width.
 * @param width - Target column width (> 0).
 * @param maxRows - Row budget.
 * @param fillBg - Background escape for each row's padding.
 * @param palette - The resolved palette (rowReset + fgDim for the marker).
 * @returns The wrapped rows.
 */
function wrapPlainAscii(
  content: string,
  width: number,
  maxRows: number,
  fillBg: string,
  palette: DiffPalette,
): string[] {
  const rows: string[] = [];
  let start = 0;
  let room = width;
  // `end` is clamped to start + room, so the pads below are never negative.
  while (start < content.length) {
    if (rows.length >= maxRows - 1) room = truncateBudget(width);
    const end = Math.min(start + room, content.length);
    const slice = content.slice(start, end);
    const open = rows.length === 0 ? "" : rows.length === 1 ? fillBg : `${fillBg}${fillBg}`;
    const truncating = rows.length >= maxRows - 1 && end < content.length;
    if (truncating) {
      rows.push(
        `${open}${slice}${fillBg}${" ".repeat(room - slice.length)}${palette.rowReset}${width > 2 ? continuationTail(palette.rowReset, palette.fgDim) : ""}`,
      );
      return rows;
    }
    rows.push(`${open}${slice}${fillBg}${" ".repeat(width - slice.length)}${palette.rowReset}`);
    start = end;
  }
  return rows;
}
