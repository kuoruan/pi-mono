/**
 * The split (side-by-side) diff view — old/new columns with a shared gutter,
 * falling back to unified on narrow terminals or wrap-heavy hunks (the
 * fallback decision itself lives in shouldUseSplit).
 */

import { expandTabs, fitAnsi } from "#src/core/ansi.ts";
import { type DiffLine, sepLabel } from "#src/core/diff.ts";
import { SEQ_DIM } from "#src/core/escapes.ts";

import {
  type DiffViewOptions,
  hiddenLinesTail,
  highlightPairSides,
  MIN_RENDER_WIDTH,
} from "./diff-view.ts";
import { injectBg } from "./inject-bg.ts";
import { borderBar, diffRowFrame, gutterWidth } from "./row-frame.ts";
import { splitWindow } from "./visible-sources.ts";
import { type CharRange, shouldEmphasize, wordDiffAnalysis } from "./word-diff.ts";
import { adaptiveWrapRows, wrapAnsi } from "./wrap.ts";

/**
 * Render the split (side-by-side) view: old/new columns sharing a line-number
 * gutter, word-level emphasis on paired lines. A pure renderer — the
 * split-vs-unified choice (shouldUseSplit) lives in the caller
 * (text-task's renderPaddedDiff).
 *
 * @param options - The shared view inputs.
 * @returns The rendered view, newline-joined.
 */
export async function renderSplit(options: DiffViewOptions): Promise<string> {
  const { diff, language, maxLines, width, view, indicator, seed } = options;
  const palette = view.palette;
  if (!diff.lines.length) return "";

  const { rows, visible, leftSource, rightSource } = splitWindow(diff.lines, maxLines);
  const renderWidth = Math.max(MIN_RENDER_WIDTH, width);
  // The gutter sizes to the numbers the visible ROWS actually display —
  // not to any line-prefix window. A paired row shows a del line AND its
  // far-away add partner (their line indices can sit well past any
  // prefix of length maxLines or of the window's logical line count), so
  // only the visible lines' own numbers are the truth (lnum does not
  // truncate; an undersized gutter would shear the layout).
  const numberWidth = Math.max(
    2,
    String(
      Math.max(
        ...visible.flatMap((row) => {
          const numbers: number[] = [];
          for (const side of [row.left, row.right]) {
            if (side && side.type !== "sep") numbers.push(side.oldNum ?? side.newNum ?? 0);
          }
          return numbers;
        }),
        0,
      ),
    ).length,
  );
  // The border column (the bar — indicatorStyle's only surface) joins
  // the budget by its own rendered width — future indicator styles
  // budget themselves; none mode's empty glyph collapses it entirely.
  // The indicator column, resolved once: its glyph sizes the gutters,
  // and when it is empty (none) a canvas-space seam stands between the
  // halves so the left code and the right gutter never fuse. Its width
  // joins the row budget — future indicator styles budget themselves
  // through the same column.
  const indicatorGlyph = borderBar(indicator);
  const gutter = gutterWidth(numberWidth, indicatorGlyph);
  const seam = indicatorGlyph ? "" : `${palette.bgBase} ${palette.rowReset}`;
  const seamWidth = seam ? 1 : 0;
  const half = Math.floor((renderWidth - seamWidth) / 2);
  const codeWidth = Math.max(12, half - gutter);
  const rowWidth = 2 * (gutter + codeWidth) + seamWidth;

  const {
    sides: [leftHighlights, rightHighlights],
  } = await highlightPairSides({
    oldSource: leftSource,
    newSource: rightSource,
    language,
    view,
    seed,
  });

  let leftIndex = 0;
  let rightIndex = 0;
  const output: string[] = [];

  // The missing half of an unpaired row (and the missing continuation rows
  // when one half wraps further): a background-filled placeholder keeps the
  // other half's geometry — without it, right-half content starts at column
  // 0 and the two-column layout collapses.
  const blankGutter = `${palette.bgBase}${" ".repeat(gutter)}${palette.rowReset}`;
  const blankBody = `${palette.bgBase}${" ".repeat(codeWidth)}${palette.rowReset}`;

  // Render one side of a row: gutter, continuation background, and the
  // wrapped body rows. An absent side renders nothing (its slots fill
  // with the placeholders above).
  const buildHalf = (
    line: DiffLine | null,
    highlight: string,
    ranges: CharRange[] | null,
    side: "left" | "right",
  ): { gutter: string; continuation: string; bodyRows: string[] } => {
    if (!line) {
      return { gutter: blankGutter, continuation: blankGutter, bodyRows: [] };
    }
    const type = line.type === "del" || line.type === "add" ? line.type : "ctx";
    // Each side shows its OWN file's number (the row pairing guarantees
    // left is a del/ctx/sep line — whose number is oldNum — and right an
    // add/ctx line — whose number is newNum; no type dispatch needed).
    const number = side === "left" ? line.oldNum : line.newNum;
    const frame = diffRowFrame({ type, number, numberWidth, palette, indicatorGlyph });
    const body =
      ranges && ranges.length > 0
        ? injectBg(highlight, {
            ranges,
            baseBg: frame.codeBg,
            highlightBg: type === "del" ? palette.bgRemovedWord : palette.bgAddedWord,
            palette,
          })
        : type === "ctx"
          ? `${palette.bgBase}${SEQ_DIM}${highlight}`
          : injectBg(highlight, { baseBg: frame.codeBg, palette });
    return {
      gutter: frame.gutter,
      continuation: frame.continuation,
      bodyRows: wrapAnsi(expandTabs(body), {
        width: codeWidth,
        maxRows: adaptiveWrapRows(renderWidth),
        fillBg: frame.codeBg,
        palette,
      }),
    };
  };

  for (const row of visible) {
    // Separator rows render once, full-width (the hunk label/gap count is
    // metadata for the whole row — rendering it per half duplicated it).
    if (row.left?.type === "sep") {
      const label = sepLabel(row.left.hunkMeta, row.left.gap ?? null);
      if (label) {
        // The whole row carries the tool background (unified's sep row
        // does the same) — the label area would otherwise show a hole when
        // the tool box background differs from the terminal's default.
        // fitAnsi's truncation re-open re-establishes background+fgDim.
        output.push(
          `${palette.bgBase}${palette.fgDim}${" ".repeat(gutter)}${fitAnsi(
            label,
            rowWidth - gutter,
            `${palette.rowReset}${palette.bgBase}${palette.fgDim}`,
            palette.fgDim,
          )}${palette.rowReset}`,
        );
      }
      continue;
    }
    const isPairedChange = row.left?.type === "del" && row.right?.type === "add";
    const wordDiff =
      isPairedChange && row.left && row.right
        ? wordDiffAnalysis(row.left.content, row.right.content)
        : null;
    // Word-level emphasis applies to BOTH halves or neither — one shared
    // verdict (shouldEmphasize) for both views.
    const emphasizeWords = isPairedChange && shouldEmphasize(wordDiff);
    // Sep rows were handled above; left/right here are ctx/del/add or null.
    const leftHighlight = row.left ? (leftHighlights[leftIndex++] ?? row.left.content) : "";
    const rightHighlight = row.right ? (rightHighlights[rightIndex++] ?? row.right.content) : "";
    const leftHalf = buildHalf(
      row.left,
      leftHighlight,
      emphasizeWords && wordDiff ? wordDiff.oldRanges : null,
      "left",
    );
    const rightHalf = buildHalf(
      row.right,
      rightHighlight,
      emphasizeWords && wordDiff ? wordDiff.newRanges : null,
      "right",
    );
    const maxRows = Math.max(leftHalf.bodyRows.length, rightHalf.bodyRows.length);
    for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
      // Missing body rows (a half that wrapped less, or an absent half) fill
      // with the blank body so the following half keeps its column.
      const leftBody = leftHalf.bodyRows[rowIndex] ?? blankBody;
      const rightBody = rightHalf.bodyRows[rowIndex] ?? blankBody;
      // First row carries the numbered gutter; continuations repeat the
      // bar over blank number/sign columns (the frame's own two shapes).
      const leftGutter = rowIndex === 0 ? leftHalf.gutter : leftHalf.continuation;
      const rightGutter = rowIndex === 0 ? rightHalf.gutter : rightHalf.continuation;
      output.push(`${leftGutter}${leftBody}${seam}${rightGutter}${rightBody}`);
    }
  }

  if (rows.length > visible.length) {
    // Count hidden LOGICAL lines (unified's unit) — but note the views can
    // still report different N for the same diff: split spends a row per
    // half (a paired add/del row = 2 logical lines), so the visible
    // window covers fewer logical lines than unified's at the same
    // maxLines. Same unit, not the same number.
    const hiddenLines = rows.slice(visible.length).reduce((sum, row) => sum + row.hiddenLines, 0);
    output.push(hiddenLinesTail(hiddenLines, palette));
  }
  return output.join("\n");
}
