/**
 * The wrap primitives: ANSI-aware wrapping to an exact column width with a
 * per-width-class row budget. Both diff views wrap every row through
 * `wrapAnsi` — the split view places its right column right after the
 * left, so unpadded rows would misalign the halves (every row occupies
 * EXACTLY the target width).
 */

import { isPlainAscii, iterateCells } from "#src/core/ansi.ts";
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
  // Non-plain content (escapes, CJK): the cell walk below handles BOTH the
  // fits and the wrap outcome itself — a fitting line emits one row via
  // the final push, byte-identical to the pad formula above — so there is
  // no separate pre-measure to pay a second walk.
  const rows: string[] = [];
  let row = "";
  let rowCols = 0;
  let onLastRow = false;
  let effectiveWidth = width;
  const tracker = new SgrState();
  /** Close the current row (pad to EXACT width) and open the next. */
  const breakRow = (): void => {
    const state = tracker.replay();
    rows.push(row + fillBg + " ".repeat(Math.max(0, width - rowCols)) + palette.rowReset);
    // The next row opens with the carried state plus a fresh fillBg —
    // the tracker must seed from that opening so its replay stays exact.
    row = state + fillBg;
    tracker.applySeq(state + fillBg);
    rowCols = 0;
    if (rows.length >= maxRows - 1) {
      onLastRow = true;
      effectiveWidth = width > 2 ? width - 1 : width;
    }
  };
  for (const cell of iterateCells(content)) {
    if (!onLastRow && rows.length >= maxRows - 1) {
      onLastRow = true;
      effectiveWidth = width > 2 ? width - 1 : width;
    }
    if (cell.escape) {
      tracker.apply(cell.text);
      row += cell.text;
      continue;
    }
    if (rowCols + cell.cols > effectiveWidth) {
      if (onLastRow) {
        // Truncation: THIS discarded cell is the proof that visible
        // content remains (escapes never reach the width check), so the
        // marker is gated only by room to draw it. It fills to width-1 on
        // the row's own background (fillBg), keeping the row at EXACTLY
        // width columns (a wide char can stop the row at width-2).
        if (width > 2) {
          rows.push(
            row +
              fillBg +
              " ".repeat(Math.max(0, effectiveWidth - rowCols)) +
              palette.rowReset +
              palette.fgDim +
              "›" +
              palette.rowReset,
          );
        } else {
          rows.push(row + fillBg + " ".repeat(Math.max(0, width - rowCols)) + palette.rowReset);
        }
        return rows;
      }
      breakRow();
    }
    row += cell.text;
    rowCols += cell.cols;
  }
  if (row.length > 0 || rows.length === 0) {
    rows.push(row + fillBg + " ".repeat(Math.max(0, width - rowCols)) + palette.rowReset);
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
  while (start < content.length) {
    if (rows.length >= maxRows - 1) room = width > 2 ? width - 1 : width;
    const end = Math.min(start + room, content.length);
    const slice = content.slice(start, end);
    const open = rows.length === 0 ? "" : rows.length === 1 ? fillBg : `${fillBg}${fillBg}`;
    const truncating = rows.length >= maxRows - 1 && end < content.length;
    if (truncating) {
      if (width > 2) {
        rows.push(
          `${open}${slice}${fillBg}${" ".repeat(Math.max(0, room - slice.length))}${palette.rowReset}${palette.fgDim}›${palette.rowReset}`,
        );
      } else {
        rows.push(
          `${open}${slice}${fillBg}${" ".repeat(Math.max(0, width - slice.length))}${palette.rowReset}`,
        );
      }
      return rows;
    }
    rows.push(
      `${open}${slice}${fillBg}${" ".repeat(Math.max(0, width - slice.length))}${palette.rowReset}`,
    );
    start = end;
  }
  return rows;
}
