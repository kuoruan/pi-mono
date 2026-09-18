/**
 * The visible-window sources for the diff views: one module owns slicing
 * the window AND splitting it into highlight sources, so the two views
 * cannot drift apart (cursor/source skew becomes unrepresentable — each
 * view consumes the aligned pair this module returns).
 *
 * The two views slice DIFFERENT things (unified slices lines, split
 * slices paired rows — the pairing changes what "the first N" means),
 * so the module offers one function per view, not one forced unified
 * shape. The filter rules (unified's ctx|del / ctx|add, split's
 * non-sep sides) live with their slice, beside the cursor contract each
 * feeds (unified-view's oldHl/newHl, split-view's row pairing).
 */

import type { DiffLine } from "#src/core/diff.ts";

/** One split-view row: the paired old/new lines. */
export interface SplitRow {
  /** The left (old) side's line, or null when this side has no partner. */
  left: DiffLine | null;
  /** The right (new) side's line, or null when this side has no partner. */
  right: DiffLine | null;
  /**
   * The row's share of the unified-view line count: a del+add pair is two
   * logical lines, ctx/sep/single-sided rows one — counted at construction,
   * never inferred from left/right occupancy (a ctx row shares its DiffLine
   * across both sides).
   */
  hiddenLines: number;
}

/**
 * Pair diff lines into split-view rows: ctx lines span both sides, sep
 * lines sit left-only, and each del/add block pairs positionally (the
 * shorter side fills with nulls).
 *
 * @param lines - The parsed diff's lines.
 * @returns The paired rows, in diff order.
 */
export function buildSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.type === "ctx") {
      rows.push({ left: line, right: line, hiddenLines: 1 });
      idx++;
      continue;
    }
    if (line.type === "sep") {
      rows.push({ left: line, right: null, hiddenLines: 1 });
      idx++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (idx < lines.length && lines[idx].type === "del") {
      dels.push(lines[idx]);
      idx++;
    }
    const adds: DiffLine[] = [];
    while (idx < lines.length && lines[idx].type === "add") {
      adds.push(lines[idx]);
      idx++;
    }
    const count = Math.max(dels.length, adds.length);
    for (let r = 0; r < count; r++) {
      const left = dels[r] ?? null;
      const right = adds[r] ?? null;
      rows.push({ left, right, hiddenLines: left && right ? 2 : 1 });
    }
  }
  return rows;
}

/** The unified view's aligned window: visible lines + their highlight sources. */
export interface UnifiedWindow {
  /** The visible diff lines (the row loop's input). */
  visible: DiffLine[];
  /** Old-side highlight source (ctx + del contents, in row order). */
  oldSource: string[];
  /** New-side highlight source (ctx + add contents, in row order). */
  newSource: string[];
}

/**
 * Slice the unified window: the first maxLines diff lines, split into
 * old/new highlight sources (the oldHl/newHl cursors in unified-view
 * consume the sources in this same row order).
 *
 * @param lines - The parsed diff's lines.
 * @param maxLines - The visible line budget.
 * @returns The aligned window.
 */
export function unifiedWindow(lines: DiffLine[], maxLines: number): UnifiedWindow {
  const visible = lines.slice(0, maxLines);
  const oldSource: string[] = [];
  const newSource: string[] = [];
  for (const line of visible) {
    if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
    if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
  }
  return { visible, oldSource, newSource };
}

/** The split view's aligned window: visible rows + their highlight sources. */
export interface SplitWindow {
  /** ALL paired rows (the hidden-line tail counts past the window). */
  rows: SplitRow[];
  /** The visible paired rows (the render loop's input). */
  visible: SplitRow[];
  /** Left-side highlight source (non-sep left contents, in row order). */
  leftSource: string[];
  /** Right-side highlight source (non-sep right contents, in row order). */
  rightSource: string[];
}
/**
 * Slice the split window: pair ALL lines first (pairing changes what
 * "the first N" means), then take the first maxLines rows, split into
 * left/right highlight sources.
 *
 * @param lines - The parsed diff's lines.
 * @param maxLines - The visible row budget.
 * @returns The aligned window.
 */
export function splitWindow(lines: DiffLine[], maxLines: number): SplitWindow {
  const rows = buildSplitRows(lines);
  const visible = rows.slice(0, maxLines);
  const leftSource: string[] = [];
  const rightSource: string[] = [];
  for (const row of visible) {
    if (row.left && row.left.type !== "sep") leftSource.push(row.left.content);
    if (row.right && row.right.type !== "sep") rightSource.push(row.right.content);
  }
  return { rows, visible, leftSource, rightSource };
}
