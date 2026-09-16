/**
 * The SGR parameter grammar: the running style state (bg, fg, open
 * attributes) an ANSI stream reduces to. The grammar lives in ONE place —
 * SgrState — so every consumer (the wrap walk's incremental tracker, and
 * any future batch reducer) stays on the same parameter semantics.
 */

import { ESC, escapeEndAt } from "./ansi.ts";

/** Match any SGR escape sequence, capturing its parameters. */
const ANSI_CAPTURE_RE = new RegExp(`${ESC}\\[([^m]*)m`, "g");

/** The reset-like sequences reinjectSgr re-injects a background after. */
const SEQ_RESET_ALL = `${ESC}[0m`;
const SEQ_RESET_FG = `${ESC}[39m`;
const SEQ_RESET_BG = `${ESC}[49m`;

/**
 * Whether a sequence is reset-like — closes enough state that the active
 * background must be re-established after it. One predicate for the two
 * consumers (reinjectSgr's pass and injectBg's per-escape re-open) so the
 * set cannot drift.
 *
 * @param escapeText - A single `ESC[...m` sequence.
 * @returns True for the full reset and the channel defaults.
 */
export function isResetLikeSequence(escapeText: string): boolean {
  return escapeText === SEQ_RESET_ALL || escapeText === SEQ_RESET_FG || escapeText === SEQ_RESET_BG;
}

/**
 * The SGR color spec's parameter count: `2;r;g;b` consumes 5 (kind +
 * three channels), `5;n` consumes 3 (kind + index), and a bare 38/48
 * (malformed) consumes just itself.
 *
 * @param kind - The spec's sub-selector (the parameter after 38/48).
 * @returns The parameter count.
 */
function colorSpecLength(kind: number | undefined): number {
  if (kind === 5) return 3;
  if (kind === 2) return 5;
  return 1;
}

/**
 * Whether the slice `text[start, end)` equals the literal `seq` — the
 * allocation-free form of `text.slice(start, end) === seq` for the fast
 * classifier.
 *
 * @param text - The source string.
 * @param start - The slice start (inclusive).
 * @param end - The slice end (exclusive).
 * @param seq - The literal to compare against.
 * @returns True when the slice equals the literal.
 */
function sliceEquals(text: string, start: number, end: number, seq: string): boolean {
  if (end - start !== seq.length) return false;
  for (let i = 0; i < seq.length; i++) {
    if (text[start + i] !== seq[i]) return false;
  }
  return true;
}

/**
 * Whether the escape span starting at `start` can continue as a
 * truecolor/indexed color spec — the classifier needs only the `2;`/`5;`
 * head; the numbers are scanned strictly against the tail itself. `end - 1`
 * is the escape end: the tail must be consumed exactly (the closing `m`
 * lies outside it).
 *
 * @param text - The source string.
 * @param start - The scan position (just past the `38;`/`48;` prefix).
 * @param end - The escape end (exclusive of the closing `m`).
 * @returns The tail offset and channel count, or null when no spec starts here.
 */
function specHeadAt(text: string, start: number, end: number): { count: number } | null {
  if (end - start < 2 || text[start + 1] !== ";") return null;
  if (text[start] === "2") return { count: 3 };
  if (text[start] === "5") return { count: 1 };
  return null;
}

/**
 * Parse exactly `count` strict `n;n;…` numbers from `text[i, end)` — the
 * allocation-free scan over the source itself (no slice, no split).
 *
 * @param text - The source string.
 * @param i - The scan position.
 * @param end - The escape end (exclusive of the closing `m`).
 * @param count - Expected number count.
 * @param out - The parsed numbers (only complete on success).
 * @returns True exactly when the tail is consumed (i === end on success).
 */
function scanTailNumbers(
  text: string,
  i: number,
  end: number,
  count: number,
  out: number[],
): boolean {
  out.length = 0;
  for (let k = 0; k < count; k++) {
    let value = 0;
    let digits = 0;
    while (i < end && text[i] >= "0" && text[i] <= "9") {
      value = value * 10 + (text.charCodeAt(i) - 48);
      i++;
      digits++;
    }
    if (digits === 0) return false;
    out.push(value);
    if (k < count - 1) {
      if (text[i] !== ";") return false;
      i++;
    }
  }
  return i === end;
}

/**
 * The running SGR state (bg, fg, open attributes) an ANSI stream reduces
 * to. The wrap walk feeds every escape cell through `apply` so a break
 * can replay the state without re-scanning the row.
 *
 * The char-by-char classifier inside `apply` exists for measured reasons:
 * the naive parse-per-escape form was 30% SLOWER than the per-break
 * batch re-scan it replaced; recognizing this pipeline's own literal
 * escape shapes (bench-verified: ~1.6× on escaped wrapped rows) closed
 * that gap. The full parameter walk stays as the semantically-exact
 * fallback for anything the classifier declines.
 */
export class SgrState {
  /** Foreground escape currently open (the full `38;…m` sequence, not a color value). */
  private fg = "";
  /** Background escape currently open (the full `48;…m` sequence, not a color value). */
  private bg = "";
  /**
   * Attribute codes currently open (1 bold, 3 italic, … — off-codes delete).
   * Lazy: most lines only carry fg/bg, so the Set is built on first add.
   */
  private attrs: Set<number> | null = null;

  /**
   * Apply one escape sequence in place. The optional span form classifies
   * directly against the source — zero slice allocations for the fast path.
   *
   * @param escapeText - A single `ESC[...m` sequence, or the source string
   *   when `start`/`end` delimit the escape within it.
   * @param start - The escape start within the source (default 0).
   * @param end - The escape end within the source (default text length).
   * @returns Nothing.
   */
  apply(escapeText: string, start = 0, end = escapeText.length): void {
    // Fast classifier first: the escapes this pipeline itself emits are
    // literal shapes (resets, channel defaults, attribute on/off) or
    // truecolor/256 forms with strict digit tails — handled without a
    // split/map allocation. Anything else takes the full parameter walk.
    if (
      sliceEquals(escapeText, start, end, "\u001b[0m") ||
      sliceEquals(escapeText, start, end, "\u001b[m")
    ) {
      this.fg = "";
      this.bg = "";
      this.attrs = null;
      return;
    }
    if (sliceEquals(escapeText, start, end, "\u001b[39m")) {
      this.fg = "";
      return;
    }
    if (sliceEquals(escapeText, start, end, "\u001b[49m")) {
      this.bg = "";
      return;
    }
    if (sliceEquals(escapeText, start, end, "\u001b[22m")) {
      this.attrs?.delete(1); // bold off (and dim off — 2)
      this.attrs?.delete(2);
      return;
    }
    if (sliceEquals(escapeText, start, end, "\u001b[23m")) {
      this.attrs?.delete(3); // italic off
      return;
    }
    if (sliceEquals(escapeText, start, end, "\u001b[24m")) {
      this.attrs?.delete(4); // underline off
      return;
    }
    if (sliceEquals(escapeText, start, end, "\u001b[29m")) {
      this.attrs?.delete(9); // strikethrough off
      return;
    }
    if (end - start === 4 && escapeText[start + 2] >= "1" && escapeText[start + 2] <= "9") {
      (this.attrs ??= new Set()).add(escapeText.charCodeAt(start + 2) - 48);
      return;
    }
    // Truecolor/256 color specs: `38;2;r;g;b` (or 48) / `38;5;n` (or 48) —
    // scanned strictly against the source tail, normalized exactly like
    // the parameter walk does. A bare 38/48 (no `;kind`) skips the
    // classifier and takes the walk.
    let kind: "38" | "48" | null = null;
    if (sliceEquals(escapeText, start, start + 5, `${ESC}[38;`)) {
      kind = "38";
    } else if (sliceEquals(escapeText, start, start + 5, `${ESC}[48;`)) {
      kind = "48";
    }
    if (kind !== null) {
      // end - 1 skips the closing `m`: the tail must consume exactly.
      const head = specHeadAt(escapeText, start + 5, end - 1);
      if (head !== null) {
        const channels: number[] = [];
        if (scanTailNumbers(escapeText, start + 7, end - 1, head.count, channels)) {
          const seq = `\u001b[${kind};${head.count === 3 ? "2" : "5"};${channels.join(";")}m`;
          if (kind === "38") this.fg = seq;
          else this.bg = seq;
          return;
        }
      }
    }
    // Full parameter walk (composite sequences like `1;38;2;…`, and
    // anything the classifier declined).
    const params = (escapeText.slice(start + 2, end - 1) || "0").split(";").map(Number);
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if (p === 0) {
        this.fg = "";
        this.bg = "";
        this.attrs = null;
      } else if (p === 39) {
        this.fg = "";
      } else if (p === 49) {
        this.bg = "";
      } else if (p === 38 || p === 48) {
        const kindP = params[i + 1];
        const len = colorSpecLength(kindP);
        const seq = `\u001b[${params.slice(i, i + len).join(";")}m`;
        if (p === 38) {
          this.fg = seq;
        } else {
          this.bg = seq;
        }
        i += len - 1;
      } else if (p === 22) {
        this.attrs?.delete(1);
        this.attrs?.delete(2);
      } else if (p === 23) {
        this.attrs?.delete(3);
      } else if (p === 24) {
        this.attrs?.delete(4);
      } else if (p === 29) {
        this.attrs?.delete(9);
      } else if (p !== undefined && p >= 1 && p <= 9) {
        (this.attrs ??= new Set()).add(p);
      }
      i++;
    }
  }

  /**
   * Apply every escape sequence in a run of text (the batch entry —
   * multi-sequence seeds like a replayed state plus fillBg flow through
   * here).
   *
   * @param text - Text containing zero or more escape sequences.
   * @returns Nothing.
   */
  applySeq(text: string): void {
    for (const match of text.matchAll(ANSI_CAPTURE_RE)) this.apply(match[0]);
  }

  /**
   * The sequences that re-open this state.
   *
   * The ORDER is a pinned byte contract (bg, fg, attrs): the wrap walk's
   * continuation rows replay it verbatim and the differential tests
   * assert the full row bytes — reordering would break the byte equality
   * that keeps every renderer snapshot valid.
   *
   * @returns The re-open sequences.
   */
  replay(): string {
    if (this.attrs === null) return this.bg + this.fg;
    const attrSeqs = [...this.attrs].map((a) => `\u001b[${a}m`).join("");
    return this.bg + this.fg + attrSeqs;
  }
}

/**
 * Re-inject `bg` after each reset-like SGR (Shiki closes tokens with the
 * ESC[39m family; 0m/49m count as broader resets). One indexOf walk over
 * the shared escape grammar (`escapeEndAt`): recognized sequences pass
 * through whole, a reset-like one re-opens the background after itself;
 * a lone ESC is text by this module's grammar and copied as-is (no
 * injection there).
 *
 * @param line - The ANSI-styled line.
 * @param bg - The background escape to re-inject.
 * @param escIndex - The first ESC offset (callers probing it already
 *   hand it over, skipping the re-scan).
 * @returns The line with backgrounds re-established.
 */
export function reinjectSgr(line: string, bg: string, escIndex: number): string {
  let i = escIndex;
  if (i === -1) return line;
  let out = "";
  let last = 0;
  while (i !== -1) {
    out += line.slice(last, i);
    const end = escapeEndAt(line, i);
    if (end === -1) {
      // Unterminated sequence or lone ESC: the cell walk's code-point
      // cell — copy the ESC byte itself and keep scanning after it.
      out += ESC;
      last = i + 1;
    } else {
      const seq = line.slice(i, end);
      out += seq;
      if (isResetLikeSequence(seq)) {
        out += bg;
      }
      last = end;
    }
    i = line.indexOf(ESC, last);
  }
  return out + line.slice(last);
}
