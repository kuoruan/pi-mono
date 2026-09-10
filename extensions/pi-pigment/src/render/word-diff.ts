/**
 * Word-diff analysis: the changed character ranges of a paired del/add
 * row (`wordDiffAnalysis`), the emphasis verdict (`shouldEmphasize`), and
 * the painters that composite word-level backgrounds (`paintWordDiff`,
 * `plainWordDiff`). One authority for the whitespace-trim and
 * code-point-counting invariants shared by the range producer and the
 * painters.
 */

import { diffWords, type Change } from "diff";

import type { DiffPalette } from "#src/theme/palette.ts";

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
  /**
   * The jsdiff change list the analysis walked — the raw material the
   * plain painter consumes directly (the unified view's fallback path
   * never re-runs diffWords on a pair it already analyzed). Treat it as
   * read-only. Note the identical-input fast path returns an EMPTY list
   * — diffWords("same", "same") would yield one common part, so
   * consumers must not equate `parts` with a fresh diffWords call.
   */
  parts: readonly Change[];
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

/**
 * Whether a code point is whitespace — the JS `\s` class, exactly as
 * jsdiff's word splitting consults it, so the trim below never disagrees
 * with jsdiff about what a "whitespace run" is. Tab IS included — it is
 * the whitespace the trim removes most (the indentation bleed); LF/CR
 * are unreachable inside a single diff line's content but staying in the
 * class keeps the classification total and identical to jsdiff's.
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
  // Identical lines (and the empty pair) are fully common by definition
  // — skip jsdiff and every walk. Zero-drift with the general path: same
  // would count every code point, maxLength equals it, similarity 1.
  if (oldText === newText) return { similarity: 1, oldRanges: [], newRanges: [], parts: [] };
  const parts = diffWords(oldText, newText);
  const oldRanges: CharRange[] = [];
  const newRanges: CharRange[] = [];
  let oldPosition = 0;
  let newPosition = 0;
  let same = 0;
  for (const part of parts) {
    if (part.removed) {
      // One pass per changed chunk: total code points plus the whitespace
      // edges' code-point tallies (no slicing — the range producer needs
      // counts, not substrings).
      const { total, lead, body } = chunkStats(part.value);
      const start = oldPosition + lead;
      const end = start + body;
      // All-whitespace chunks (an indentation-only edit) highlight nothing.
      if (end > start) oldRanges.push([start, end]);
      oldPosition += total;
    } else if (part.added) {
      const { total, lead, body } = chunkStats(part.value);
      const start = newPosition + lead;
      const end = start + body;
      if (end > start) newRanges.push([start, end]);
      newPosition += total;
    } else {
      const total = countCodePoints(part.value);
      same += total;
      oldPosition += total;
      newPosition += total;
    }
  }
  const maxLength = Math.max(countCodePoints(oldText), countCodePoints(newText));
  return {
    similarity: maxLength > 0 ? same / maxLength : 1,
    oldRanges,
    newRanges,
    parts,
  };
}

/**
 * One changed chunk's tallies from a single pass: total code points, and
 * the leading-whitespace / body / trailing-whitespace split in code
 * points. No allocations — the range producer consumes counts, only
 * plainWordDiff (the string painter) calls trimChunkWhitespace for the
 * actual substrings.
 *
 * @param value - The chunk.
 * @returns The tallies.
 */
function chunkStats(value: string): { total: number; lead: number; body: number; trail: number } {
  let total = 0;
  let firstNonWs = -1;
  let lastNonWsEnd = 0;
  let i = 0;
  while (i < value.length) {
    const cp = value.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    if (!isWhitespaceCodePoint(cp)) {
      if (firstNonWs === -1) firstNonWs = total;
      lastNonWsEnd = total + 1;
    }
    total += 1;
    i += len;
  }
  if (firstNonWs === -1) return { total, lead: total, body: 0, trail: 0 };
  return { total, lead: firstNonWs, body: lastNonWsEnd - firstNonWs, trail: total - lastNonWsEnd };
}

/**
 * Count code points (not UTF-16 code units) in plain text — a direct
 * surrogate-aware walk, allocation-free (the iterateCells form yields one
 * cell object per code point; the range producer pays this per chunk and
 * per line, where escape handling is never needed).
 *
 * @param text - The plain text to count.
 * @returns The code-point count.
 */
function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // A high surrogate pairs ONLY with a following low surrogate (one
    // code point, two units). A lone high surrogate counts as one cell —
    // UTF-8 decode never produces one (invalid bytes become U+FFFD), but
    // exact parity with the iterateCells walk costs one branch and keeps
    // the two counters identical on every input class.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/**
 * A word-emphasized paired row: each side's plain text with the
 * word-level backgrounds composited in (paintWordDiff's output).
 */
export interface EmphasizedPair {
  /** The old side's painted text (removed-word emphasis). */
  old: string;
  /** The new side's painted text (added-word emphasis). */
  new: string;
}

/**
 * Paint a word diff's change list: changed words get the brighter
 * word-backgrounds, shared words stay on the line bg. The parts come from
 * a prior analysis (or a direct diffWords) — one jsdiff pass per pair
 * feeds both the verdict and this painter.
 *
 * @param parts - The jsdiff change list for the pair.
 * @param palette - The resolved palette (word-level backgrounds).
 * @returns The emphasized old/new pair.
 */
export function paintWordDiff(parts: readonly Change[], palette: DiffPalette): EmphasizedPair {
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
 * Word-level emphasis for unhighlighted (fallback) paired lines — the
 * standalone form (its own jsdiff pass) for callers with no prior
 * analysis; the unified view pairs this with wordDiffAnalysis's parts
 * through paintWordDiff instead.
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
): EmphasizedPair {
  return paintWordDiff(diffWords(oldText, newText), palette);
}
