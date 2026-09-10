/**
 * The SGR parameter grammar: the running style state (bg, fg, open
 * attributes) an ANSI stream reduces to. The grammar lives in ONE place —
 * SgrState — so every consumer (the wrap walk's incremental tracker, and
 * any future batch reducer) stays on the same parameter semantics.
 */

/** The ESC control character every ANSI escape sequence starts with. */
const ESC = "\u001b";

/** Match any SGR escape sequence, capturing its parameters. */
const ANSI_CAPTURE_RE = new RegExp(`${ESC}\\[([^m]*)m`, "g");

/** The extended-color selector prefixes (fg and bg forms, both length 5). */
const SPEC_38 = `${ESC}[38;`;
const SPEC_48 = `${ESC}[48;`;

/** The reset-like sequences reinjectSgr re-injects a background after. */
const SEQ_RESET_ALL = `${ESC}[0m`;
const SEQ_RESET_FG = `${ESC}[39m`;
const SEQ_RESET_BG = `${ESC}[49m`;

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
 * Scan a strict `n;n;…` number tail (digits and separators only) — the
 * allocation-free alternative to split/map for the escape shapes this
 * pipeline emits.
 *
 * @param body - The parameter body after the leading selector.
 * @param count - Expected number count.
 * @returns The parsed numbers, or null when the shape doesn't match.
 */
function scanStrictNumbers(body: string, count: number): number[] | null {
  const nums: number[] = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    let value = 0;
    let digits = 0;
    while (i < body.length && body[i] >= "0" && body[i] <= "9") {
      value = value * 10 + (body.charCodeAt(i) - 48);
      i++;
      digits++;
    }
    if (digits === 0) return null;
    nums.push(value);
    if (k < count - 1) {
      if (body[i] !== ";") return null;
      i++;
    }
  }
  return i === body.length ? nums : null;
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
  /** Attribute codes currently open (1 bold, 3 italic, … — off-codes delete). */
  private attrs = new Set<number>();

  /**
   * Apply one escape sequence in place.
   *
   * @param escapeText - A single `ESC[...m` sequence.
   * @returns Nothing.
   */
  apply(escapeText: string): void {
    // Fast classifier first: the escapes this pipeline itself emits are
    // literal shapes (resets, channel defaults, attribute on/off) or
    // truecolor/256 forms with strict digit tails — handled without a
    // split/map allocation. Anything else takes the full parameter walk.
    if (escapeText === "\u001b[0m" || escapeText === "\u001b[m") {
      this.fg = "";
      this.bg = "";
      this.attrs.clear();
      return;
    }
    if (escapeText === "\u001b[39m") {
      this.fg = "";
      return;
    }
    if (escapeText === "\u001b[49m") {
      this.bg = "";
      return;
    }
    if (escapeText === "\u001b[22m") {
      this.attrs.delete(1); // bold off (and dim off — 2)
      this.attrs.delete(2);
      return;
    }
    if (escapeText === "\u001b[23m") {
      this.attrs.delete(3); // italic off
      return;
    }
    if (escapeText === "\u001b[24m") {
      this.attrs.delete(4); // underline off
      return;
    }
    if (escapeText === "\u001b[29m") {
      this.attrs.delete(9); // strikethrough off
      return;
    }
    if (escapeText.length === 4 && escapeText[2] >= "1" && escapeText[2] <= "9") {
      this.attrs.add(escapeText.charCodeAt(2) - 48);
      return;
    }
    // Truecolor/256 color specs: `38;2;r;g;b` (or 48) / `38;5;n` (or 48) —
    // scanned strictly, normalized exactly like the parameter walk does.
    // A bare 38/48 (no `;kind`) skips the classifier and takes the walk.
    let kind: "38" | "48" | null = null;
    if (escapeText.startsWith(SPEC_38)) {
      kind = "38";
    } else if (escapeText.startsWith(SPEC_48)) {
      kind = "48";
    }
    if (kind !== null) {
      const body = escapeText.slice(SPEC_38.length, -1);
      const rgb = body.startsWith("2;") ? scanStrictNumbers(body.slice(2), 3) : null;
      if (rgb !== null) {
        const seq = `\u001b[${kind};2;${rgb.join(";")}m`;
        if (kind === "38") this.fg = seq;
        else this.bg = seq;
        return;
      }
      const indexed = body.startsWith("5;") ? scanStrictNumbers(body.slice(2), 1) : null;
      if (indexed !== null) {
        const seq = `\u001b[${kind};5;${indexed[0]}m`;
        if (kind === "38") this.fg = seq;
        else this.bg = seq;
        return;
      }
    }
    // Full parameter walk (composite sequences like `1;38;2;…`, and
    // anything the classifier declined).
    const params = (escapeText.slice(2, -1) || "0").split(";").map(Number);
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if (p === 0) {
        this.fg = "";
        this.bg = "";
        this.attrs.clear();
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
        this.attrs.delete(1);
        this.attrs.delete(2);
      } else if (p === 23) {
        this.attrs.delete(3);
      } else if (p === 24) {
        this.attrs.delete(4);
      } else if (p === 29) {
        this.attrs.delete(9);
      } else if (p >= 1 && p <= 9) {
        this.attrs.add(p);
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
    const attrSeqs = [...this.attrs].map((a) => `\u001b[${a}m`).join("");
    return this.bg + this.fg + attrSeqs;
  }
}

/**
 * Re-inject `bg` after each reset-like SGR (Shiki closes tokens with the
 * ESC[39m family; 0m/49m count as broader resets). One indexOf walk
 * (SIMD substring search) with the same whole-sequence semantics the
 * iterateCells walk pins: an escape cell is ESC + everything up to the
 * next "m"; a lone ESC without a terminator is a code point and copied
 * as-is (no injection there).
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
    const end = line.indexOf("m", i + 1);
    if (end === -1) {
      // Lone ESC: the cell walk yields it as one code point and keeps
      // scanning after it; copy one byte and continue the search.
      last = i + 1;
      i = line.indexOf(ESC, last);
      continue;
    }
    const seq = line.slice(i, end + 1);
    out += seq;
    if (seq === SEQ_RESET_ALL || seq === SEQ_RESET_FG || seq === SEQ_RESET_BG) {
      out += bg;
    }
    last = end + 1;
    i = line.indexOf(ESC, last);
  }
  return out + line.slice(last);
}
