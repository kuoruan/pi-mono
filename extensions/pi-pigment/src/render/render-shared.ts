/**
 * Shared renderer primitives: the palette snapshot the renderers read, the
 * fg-color view (`resolveDiffPalette`), and the layout helpers (wrapping,
 * line numbers, background injection, word-diff analysis) both views use.
 */

import { diffWords } from "diff";

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import { expandTabs, isPlainAscii, iterateCells, measurePlain } from "#src/core/ansi.ts";
import type { DiffLine, ParsedDiff } from "#src/core/diff.ts";
import { SgrState } from "#src/core/sgr.ts";
import { hlBlock, MAX_HL_CHARS } from "#src/theme/highlight.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

/** The inputs both diff views share (split and unified take one frame). */
export interface DiffViewOptions {
  /** The parsed diff. */
  diff: ParsedDiff;
  /** Shiki language for highlighting (undefined skips it). */
  language: BundledLanguage | undefined;
  /** Row budget for the visible window. */
  maxLines: number;
  /** Render width in columns (the views clamp to MIN_RENDER_WIDTH). */
  width: number;
  /** The resolved palette (all diff colors). */
  palette: DiffPalette;
  /** The active pi theme (syntax highlighting source). */
  piTheme?: PaletteTheme;
  /**
   * Left-edge change indicator style (config: indicatorStyle) — the
   * caller's configured style, always explicit (no default: the config
   * owns it).
   */
  indicator: IndicatorStyle;
  /**
   * Grammar-state seed for embedded grammars (vue/html): the file text
   * before the first visible hunk. A diff slice has no `<script>` tag in
   * view, so tokenizing from the grammar's top level leaves script lines
   * uncolored; the seed re-enters the TextMate stack at the slice point.
   */
  seed?: string;
}

/** Split view needs at least this total width for two readable code columns. */
const SPLIT_MIN_WIDTH = 80;
/** Split view needs at least this many code columns per side. */
const SPLIT_MIN_CODE_WIDTH = 24;
/** Split view rejects diffs whose visible lines wrap more than this ratio. */
const SPLIT_MAX_WRAP_RATIO = 0.35;
/** Split view rejects diffs with more than this many wrapping lines (absolute). */
const SPLIT_MAX_WRAP_LINES = 10;
/** Word-level emphasis requires at least this similarity between paired lines. */
const WORD_DIFF_MIN_SIM = 0.15;

/**
 * A half-open character range (code-point offsets, `[start, end)`) — the
 * word-emphasis unit both diff views inject backgrounds over.
 */
export type CharRange = [number, number];

/**
 * The word-level diff of a paired old/new line: the changed character
 * ranges per side plus the lines' similarity (shared characters over the
 * longer line).
 */
export interface WordDiff {
  /** The similarity score (1 = identical). */
  similarity: number;
  /** The old side's changed ranges. */
  oldRanges: CharRange[];
  /** The new side's changed ranges. */
  newRanges: CharRange[];
}

/**
 * Whether a paired del/add row warrants word-level emphasis: the
 * analysis produced ranges on BOTH sides (one-sided emphasis would paint
 * a phantom change) and the similarity clears the noise floor. One
 * shared verdict for both views.
 *
 * @param wordDiff - The paired row's word-diff analysis (null when the
 *   row is not a single del/add pair).
 * @returns True when the ranges should be emphasized (a type predicate:
 *   the caller's wordDiff is non-null whenever it holds).
 */
export function shouldEmphasize(wordDiff: WordDiff | null): wordDiff is WordDiff {
  return (
    wordDiff !== null &&
    wordDiff.oldRanges.length > 0 &&
    wordDiff.newRanges.length > 0 &&
    wordDiff.similarity >= WORD_DIFF_MIN_SIM
  );
}
/** Row budget for one wrapping line on wide terminals (≥180 columns). */
const MAX_WRAP_ROWS_WIDE = 3;
/** Row budget for one wrapping line on medium terminals (≥120 columns). */
const MAX_WRAP_ROWS_MED = 2;
/** Row budget for one wrapping line on narrow terminals (below 120 columns). */
const MAX_WRAP_ROWS_NARROW = 1;
/** Renders below this width fall back to the unified view (split needs two code columns). */
export const MIN_RENDER_WIDTH = 40;

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

/**
 * Whether a code point is whitespace — the JS `\s` class (excluding the
 * already-handled tab/newline structure), the same class jsdiff's word
 * splitting consults, so the trim below never disagrees with jsdiff about
 * what a "whitespace run" is.
 *
 * @param cp - The code point.
 * @returns True for every JS-\s member.
 */
function isWhitespaceCodePoint(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000 ||
    cp === 0xfeff
  );
}

/** A diff chunk split into its whitespace edges and its body. */
interface TrimmedChunk {
  /** Leading whitespace code units. */
  lead: string;
  /** The chunk's non-whitespace body ("" for all-whitespace chunks). */
  body: string;
  /** Trailing whitespace code units. */
  trail: string;
}

/**
 * Split a changed chunk's whitespace edges off its body. jsdiff's
 * `diffWords` merges adjacent whitespace INTO the changed words
 * (`\toldValue` is ONE removed chunk — an indented edit highlight would
 * paint the tab too, and after expandTabs the bleed doubles to two
 * columns). The word highlight belongs on the word: both the range
 * producer (wordDiffAnalysis) and the plain path (plainWordDiff) trim
 * through this split.
 *
 * @param value - A changed chunk's value.
 * @returns The split.
 */
function trimChunkWhitespace(value: string): TrimmedChunk {
  let start = -1;
  let end = value.length;
  let i = 0;
  while (i < value.length) {
    const cp = value.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    if (!isWhitespaceCodePoint(cp)) {
      if (start === -1) start = i;
      end = i + len;
    }
    i += len;
  }
  if (start === -1) return { lead: value, body: "", trail: "" };
  return { lead: value.slice(0, start), body: value.slice(start, end), trail: value.slice(end) };
}

/**
 * Word-level change analysis: the changed char ranges in the old and new
 * texts plus a similarity score. `diffWords` granularity, measured in
 * code points so wide/code-unit-multi characters never shift ranges.
 *
 * Whitespace jsdiff merges into a changed chunk stays OUT of the ranges
 * (the highlight must cover the word, not the indentation). NOTE: jsdiff's
 * greedy alignment can highlight a DIFFERENT occurrence when identical
 * words repeat in the line — the word-diff definition (git/GitHub behave
 * the same), not a position bug.
 *
 * @param oldText - The old line.
 * @param newText - The new line.
 * @returns The ranges and similarity.
 */
export function wordDiffAnalysis(oldText: string, newText: string): WordDiff {
  if (!oldText && !newText) return { similarity: 1, oldRanges: [], newRanges: [] };
  const parts = diffWords(oldText, newText);
  const oldRanges: CharRange[] = [];
  const newRanges: CharRange[] = [];
  let oldPosition = 0;
  let newPosition = 0;
  let same = 0;
  for (const part of parts) {
    const codePoints = countCodePoints(part.value);
    if (part.removed) {
      const { lead, body } = trimChunkWhitespace(part.value);
      const start = oldPosition + countCodePoints(lead);
      const end = start + countCodePoints(body);
      // All-whitespace chunks (an indentation-only edit) highlight nothing.
      if (end > start) oldRanges.push([start, end]);
      oldPosition += codePoints;
    } else if (part.added) {
      const { lead, body } = trimChunkWhitespace(part.value);
      const start = newPosition + countCodePoints(lead);
      const end = start + countCodePoints(body);
      if (end > start) newRanges.push([start, end]);
      newPosition += codePoints;
    } else {
      same += codePoints;
      oldPosition += codePoints;
      newPosition += codePoints;
    }
  }
  const maxLength = Math.max(countCodePoints(oldText), countCodePoints(newText));
  return { similarity: maxLength > 0 ? same / maxLength : 1, oldRanges, newRanges };
}

/**
 * Count code points (not UTF-16 code units) in a string.
 *
 * @param text - The text to count.
 * @returns The code-point count.
 */
function countCodePoints(text: string): number {
  let count = 0;
  for (const cell of iterateCells(text)) count += cell.chars;
  return count;
}

/** Shared no-ranges default (one allocation, custom rows' common case). */
const EMPTY_RANGES: readonly CharRange[] = [];

/** The injectBg inputs. */
export interface InjectBgOptions {
  /** [start, end) visible-character ranges emphasized with highlightBg. */
  ranges?: CharRange[];
  /** Background escape for the whole line. */
  baseBg: string;
  /** Background escape for the ranges (baseBg when omitted). */
  highlightBg?: string;
  /**
   * The diff palette: its rowReset closes the row (diff rows). Omitted
   * for CUSTOM rows — the baseBg continues the row's tail, so the frame
   * padding never borrows the diff canvas (the green stripe bug).
   */
  palette?: DiffPalette;
}

/**
 * Layer a background under an ANSI line: `baseBg` everywhere, switching to
 * `highlightBg` across the given visible ranges. Escape sequences carry no
 * width and any reset-like SGR re-injects the active background.
 *
 * @param ansiLine - ANSI-styled line.
 * @param options - The injection inputs.
 * @returns The line with backgrounds composited in.
 */
export function injectBg(ansiLine: string, options: InjectBgOptions): string {
  const { ranges, baseBg, highlightBg, palette } = options;
  const rangeList = ranges ?? EMPTY_RANGES;
  const emphasisBg = highlightBg ?? baseBg;
  const rowEnd = palette?.rowReset ?? baseBg;
  let output = baseBg;
  let visible = 0;
  let inHighlight = false;
  let rangeIndex = 0;
  for (const cell of iterateCells(ansiLine)) {
    if (cell.escape) {
      output += cell.text;
      // Re-inject bg after any reset-like sequence (Shiki uses \x1b[39m
      // between tokens; some terminals may treat it as a broader reset).
      if (cell.text === "\x1b[0m" || cell.text === "\x1b[39m" || cell.text === "\x1b[49m") {
        output += inHighlight ? emphasisBg : baseBg;
      }
      continue;
    }
    while (rangeIndex < rangeList.length && visible >= rangeList[rangeIndex][1]) rangeIndex += 1;
    const wantsHighlight =
      rangeIndex < rangeList.length &&
      visible >= rangeList[rangeIndex][0] &&
      visible < rangeList[rangeIndex][1];
    if (wantsHighlight !== inHighlight) {
      inHighlight = wantsHighlight;
      output += inHighlight ? emphasisBg : baseBg;
    }
    // Code-point offsets are the unit the word-diff ranges are produced
    // in (see wordDiffAnalysis) — one visible character per cell.
    output += cell.text;
    visible += 1;
  }
  return output + rowEnd;
}

/**
 * Word-level emphasis for unhighlighted (fallback) paired lines: changed
 * words get the brighter word-backgrounds, shared words stay on the line bg.
 *
 * @param oldText - Plain old line content.
 * @param newText - Plain new line content.
 * @param palette - The resolved palette (word-level backgrounds).
 * @returns The emphasized old/new pair.
 */
export function plainWordDiff(
  oldText: string,
  newText: string,
  palette: DiffPalette,
): { old: string; new: string } {
  const parts = diffWords(oldText, newText);
  let oldOutput = "";
  let newOutput = "";
  for (const part of parts) {
    if (part.removed) {
      const { lead, body, trail } = trimChunkWhitespace(part.value);
      oldOutput += lead;
      if (body)
        oldOutput += `${palette.bgRemovedWord}${body}${palette.rowReset}${palette.bgRemoved}`;
      oldOutput += trail;
    } else if (part.added) {
      const { lead, body, trail } = trimChunkWhitespace(part.value);
      newOutput += lead;
      if (body) newOutput += `${palette.bgAddedWord}${body}${palette.rowReset}${palette.bgAdded}`;
      newOutput += trail;
    } else {
      oldOutput += part.value;
      newOutput += part.value;
    }
  }
  return { old: oldOutput, new: newOutput };
}

/**
 * Render raw output lines in pi's native look (the toolOutput foreground,
 * one line at a time) — the plain/dim fallback grep paints before (or
 * instead of) highlighting.
 *
 * @param lines - The output lines (empty array renders empty).
 * @param theme - The active pi theme.
 * @returns The styled text.
 */
export function renderPlainOutput(lines: readonly string[], theme: PaletteTheme): string {
  if (!lines.length) return "";
  return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
}

/** The highlightPairSides inputs. */
export interface HighlightSidesOptions {
  /** Old-side source lines. */
  oldSource: string[];
  /** New-side source lines. */
  newSource: string[];
  /** The language (undefined = plain pass-through). */
  language: BundledLanguage | undefined;
  /** The resolved palette (hlBlock's theme input). */
  palette: DiffPalette;
  /** The pi theme behind it. */
  piTheme: PaletteTheme | undefined;
  /** The grammar-state seed (embedded grammars). */
  seed?: string;
}

/**
 * Highlight both sides of a diff view: one hlBlock per side, in parallel,
 * gated on the combined character budget (above MAX_HL_CHARS the sources
 * pass through unstyled — the same fallback the large-diff path uses).
 * Both views collect their visible window's sources first; this is the
 * one choke point where those sources become highlighted (or don't).
 *
 * @param options - The sides to highlight.
 * @returns The [old, new] line arrays (highlighted or passed through) and
 *   whether highlighting ran — the views freeze their cursors when it
 *   did not (the plain-text paths consume nothing).
 */
export async function highlightPairSides(
  options: HighlightSidesOptions,
): Promise<{ sides: [string[], string[]]; highlighted: boolean }> {
  const { oldSource, newSource, language, palette, piTheme, seed } = options;
  // Gate on what will actually be highlighted (the visible window's
  // sources), not the whole files — a large file with a small edit still
  // highlights.
  const sourceChars =
    oldSource.reduce((n, line) => n + line.length, 0) +
    newSource.reduce((n, line) => n + line.length, 0);
  if (sourceChars > MAX_HL_CHARS) return { sides: [oldSource, newSource], highlighted: false };
  const sides = await Promise.all([
    hlBlock({
      code: oldSource.join("\n"),
      language,
      palette,
      piTheme,
      seed,
    }),
    hlBlock({
      code: newSource.join("\n"),
      language,
      palette,
      piTheme,
      seed,
    }),
  ]);
  return { sides, highlighted: true };
}
