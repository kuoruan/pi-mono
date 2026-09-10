/**
 * Background injection: layer a base background under an ANSI line with
 * per-range emphasis backgrounds — the word-emphasis painter both diff
 * views and the header helpers composite through.
 */

import { ESC, isPlainAscii, iterateCells } from "#src/core/ansi.ts";
import { reinjectSgr } from "#src/core/sgr.ts";
import type { DiffPalette } from "#src/theme/palette.ts";

import type { CharRange } from "./word-diff.ts";

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
  // One ESC probe decides every later branch: memchr-fast, stops at the
  // first ESC on styled lines (no full-line regex scan wasted on them).
  const escIndex = ansiLine.indexOf(ESC);
  if (rangeList.length === 0) {
    // No emphasis ranges: the only work is the base bg wrap plus the reset
    // reinjection. An escape-free line (any charset) needs neither;
    // otherwise reinjectSgr resumes from the known first ESC.
    if (escIndex === -1) return `${baseBg}${ansiLine}${rowEnd}`;
    return `${baseBg}${reinjectSgr(ansiLine, baseBg, escIndex)}${rowEnd}`;
  }
  if (escIndex === -1 && isPlainAscii(ansiLine)) {
    // Plain ASCII with ranges: no escape scanning, no per-cell
    // allocations. Range units are code-point offsets; plain ASCII makes
    // one code unit equal one code point, so the walk indexes the string
    // directly. The range advance and toggle logic mirror the general
    // path exactly.
    let output = baseBg;
    let visible = 0;
    let inHighlight = false;
    let rangeIndex = 0;
    for (let i = 0; i < ansiLine.length; i++) {
      while (rangeIndex < rangeList.length && visible >= rangeList[rangeIndex][1]) rangeIndex += 1;
      const wantsHighlight =
        rangeIndex < rangeList.length &&
        visible >= rangeList[rangeIndex][0] &&
        visible < rangeList[rangeIndex][1];
      if (wantsHighlight !== inHighlight) {
        inHighlight = wantsHighlight;
        output += inHighlight ? emphasisBg : baseBg;
      }
      output += ansiLine[i];
      visible += 1;
    }
    return output + rowEnd;
  }
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
