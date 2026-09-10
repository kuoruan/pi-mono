/**
 * The unified (stacked) diff view — single line-number column, full-width
 * code, paired del/add lines with word-level emphasis.
 */

import { DIM, expandTabs, measurePlain } from "#src/core/ansi.ts";
import { sepLabel, type DiffLine } from "#src/core/diff.ts";

import { injectBg } from "./inject-bg.ts";
import { type DiffViewOptions, highlightPairSides, MIN_RENDER_WIDTH } from "./render-shared.ts";
import { borderBar, diffRowFrame, gutterWidth, lineNumberWidth } from "./row-frame.ts";
import { paintWordDiff, shouldEmphasize, wordDiffAnalysis } from "./word-diff.ts";
import { adaptiveWrapRows, wrapAnsi } from "./wrap.ts";

/**
 * Render the unified (stacked) view: one line-number gutter, full-width
 * code, paired del/add lines with word-level emphasis on similar pairs.
 * Falls back to plain text for unknown languages or oversized diffs.
 *
 * @param options - The shared view inputs.
 * @returns The rendered view, newline-joined.
 */
export async function renderUnified(options: DiffViewOptions): Promise<string> {
  const { diff, language, maxLines, width, palette, piTheme, indicator, seed } = options;
  if (!diff.lines.length) return "";
  const visible = diff.lines.slice(0, maxLines);
  const renderWidth = Math.max(MIN_RENDER_WIDTH, width);
  const numberWidth = lineNumberWidth(diff.lines, maxLines);
  // The border column (the bar — indicatorStyle's only surface) joins
  // the budget by its own rendered width — future indicator styles
  // budget themselves; none mode's empty glyph collapses it entirely.
  // The indicator column, resolved once: its glyph sizes the gutter.
  const indicatorGlyph = borderBar(indicator);
  const gutter = gutterWidth(numberWidth, indicatorGlyph);

  const codeWidth = Math.max(20, renderWidth - gutter);

  const oldSource: string[] = [];
  const newSource: string[] = [];
  for (const line of visible) {
    if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
    if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
  }
  const {
    sides: [oldHighlights, newHighlights],
    highlighted: canHighlight,
  } = await highlightPairSides({
    oldSource,
    newSource,
    language,
    palette,
    piTheme,
    seed,
  });

  let oldIndex = 0;
  let newIndex = 0;
  const output: string[] = [];

  // Append one unified row (sign + line number + body) to the output.
  const emitRow = (type: "del" | "add" | "ctx", number: number | null, body: string): void => {
    const frame = diffRowFrame({ type, number, numberWidth, palette, indicatorGlyph });
    const rows = wrapAnsi(expandTabs(body), {
      width: codeWidth,
      maxRows: adaptiveWrapRows(renderWidth),
      fillBg: frame.codeBg,
      palette,
    });
    output.push(`${frame.gutter}${rows[0]}${palette.rowReset}`);
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      output.push(`${frame.continuation}${rows[rowIndex]}${palette.rowReset}`);
    }
  };

  // The highlight cursor for one side: ctx lines advance both, dels the
  // old, adds the new (the same feeds the source arrays above). Only the
  // HIGHLIGHTED mode reads the arrays — when highlighting is off (over
  // the char budget), every render path uses the line's own content and
  // the cursors stay frozen: advancing selectively would desync them
  // (the plain-text del/add paths consume nothing, so a ctx cursor step
  // would hand later ctx rows a del row's content).
  const oldHl = (line: DiffLine): string =>
    canHighlight ? (oldHighlights[oldIndex++] ?? line.content) : line.content;
  const newHl = (line: DiffLine): string =>
    canHighlight ? (newHighlights[newIndex++] ?? line.content) : line.content;

  let index = 0;
  while (index < visible.length) {
    const line = visible[index];
    if (line.type === "sep") {
      const label = sepLabel(line.hunkMeta, line.gap ?? null);
      if (label) {
        const totalWidth = Math.min(renderWidth, 72);
        // Column measure, not code units (CJK function-context labels center correctly).
        const padding = Math.max(0, totalWidth - measurePlain(label) - 2);
        const left = Math.floor(padding / 2);
        const right = padding - left;
        output.push(
          `${palette.bgBase}${palette.fgDim}${"─".repeat(left)}${label}${"─".repeat(right)}${palette.rowReset}`,
        );
      }
      index++;
      continue;
    }
    if (line.type === "ctx") {
      emitRow("ctx", line.newNum, `${palette.bgBase}${DIM}${oldHl(line)}`);
      newIndex++;
      index++;
      continue;
    }

    // A del/add block: collect both sides, then emphasize the single pair
    // when the word diff clears the bar.
    const deletions: DiffLine[] = [];
    while (index < visible.length && visible[index].type === "del") {
      deletions.push(visible[index]);
      index++;
    }
    const additions: DiffLine[] = [];
    while (index < visible.length && visible[index].type === "add") {
      additions.push(visible[index]);
      index++;
    }
    const d = deletions[0];
    const a = additions[0];
    const wordDiff =
      deletions.length === 1 && additions.length === 1 && d && a
        ? wordDiffAnalysis(d.content, a.content)
        : null;
    // One verdict for both halves or neither (shouldEmphasize); the
    // emphasis renders from the highlights when available, plain text
    // otherwise.
    if (shouldEmphasize(wordDiff) && d && a) {
      if (canHighlight) {
        emitRow(
          "del",
          d.oldNum,
          injectBg(oldHl(d), {
            ranges: wordDiff.oldRanges,
            baseBg: palette.bgRemoved,
            highlightBg: palette.bgRemovedWord,
            palette,
          }),
        );
        emitRow(
          "add",
          a.newNum,
          injectBg(newHl(a), {
            ranges: wordDiff.newRanges,
            baseBg: palette.bgAdded,
            highlightBg: palette.bgAddedWord,
            palette,
          }),
        );
      } else {
        // The analysis already ran the pair's word diff — its parts feed
        // the painter directly, so the plain path pays one diffWords per
        // pair (not two).
        const plain = paintWordDiff(wordDiff.parts, palette);
        emitRow("del", d.oldNum, `${palette.bgRemoved}${plain.old}`);
        emitRow("add", a.newNum, `${palette.bgAdded}${plain.new}`);
      }
      continue;
    }
    for (const deletion of deletions) {
      const body = canHighlight
        ? injectBg(oldHl(deletion), { baseBg: palette.bgRemoved, palette })
        : `${palette.bgRemoved}${deletion.content}`;
      emitRow("del", deletion.oldNum, body);
    }
    for (const addition of additions) {
      const body = canHighlight
        ? injectBg(newHl(addition), { baseBg: palette.bgAdded, palette })
        : `${palette.bgAdded}${addition.content}`;
      emitRow("add", addition.newNum, body);
    }
  }

  if (diff.lines.length > visible.length) {
    output.push(
      `${palette.bgBase}${palette.fgDim}  ... (${diff.lines.length - visible.length} more lines)${palette.rowReset}`,
    );
  }
  return output.join("\n");
}
