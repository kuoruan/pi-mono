/**
 * The split verdict: whether the split (side-by-side) view suits a diff —
 * a purely geometric decision (width, gutter budget, del/add balance,
 * wrap ratio). The choice is per-render; everything the verdict rejects
 * falls back to the unified view.
 */

import { expandTabs, measurePlain } from "#src/core/ansi.ts";
import type { ParsedDiff } from "#src/core/diff.ts";

import { lineNumberWidth } from "./row-frame.ts";

/** Split view needs at least this total width for two readable code columns. */
const SPLIT_MIN_WIDTH = 80;
/** Split view needs at least this many code columns per side. */
const SPLIT_MIN_CODE_WIDTH = 24;
/** Split view rejects diffs whose visible lines wrap more than this ratio. */
const SPLIT_MAX_WRAP_RATIO = 0.35;
/** Split view rejects diffs with more than this many wrapping lines (absolute). */
const SPLIT_MAX_WRAP_LINES = 10;

/**
 * Whether the split view suits this diff: a balanced del/add mix over the
 * visible window, enough code columns on each side, and few lines that would
 * wrap. Everything else falls back to the unified view.
 *
 * @param diff - The parsed diff.
 * @param width - Render width in columns.
 * @param maxRows - Visible row budget.
 * @returns True when the split view should render.
 */
export function shouldUseSplit(diff: ParsedDiff, width: number, maxRows: number): boolean {
  if (!diff.lines.length) return false;
  if (width < SPLIT_MIN_WIDTH) return false;
  // A prefix-window gutter ESTIMATE (renderSplit sizes to the visible
  // rows' own numbers, which can be a digit wider when paired rows pull
  // far-away numbers into view). Accepted: the decision only needs an
  // approximate code width for the wrap analysis, and wrapAnsi re-fits
  // at the real width — a slightly optimistic split choice costs a
  // tighter wrap, never a broken layout.
  const numberWidth = lineNumberWidth(diff.lines, maxRows);
  const half = Math.floor(width / 2);
  // Mirrors the renderer's gutter: 1 border column (the bar) +
  // numberWidth + 3 spacing (the estimate adds the bar column as +1
  // instead of measuring the glyph — a deliberate rough figure).
  const gutterEstimate = numberWidth + 4;

  const codeWidth = Math.max(12, half - gutterEstimate);
  if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false;
  const visibleLines = diff.lines.slice(0, maxRows);
  const visibleAdd = visibleLines.filter((line) => line.type === "add").length;
  const visibleDel = visibleLines.filter((line) => line.type === "del").length;
  if (visibleAdd === 0 || visibleDel === 0) return false;
  if (Math.max(visibleAdd, visibleDel) > Math.min(visibleAdd, visibleDel) * 2) return false;

  let contentLines = 0;
  let wrapCandidates = 0;
  for (const line of visibleLines) {
    if (line.type === "sep") continue;
    contentLines += 1;
    // Column measure, not code units: a CJK line of 20 chars is 40 columns.
    if (measurePlain(expandTabs(line.content)) > codeWidth) wrapCandidates += 1;
  }
  if (contentLines === 0) return true;
  const wrapRatio = wrapCandidates / contentLines;
  if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
  if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
  return true;
}
