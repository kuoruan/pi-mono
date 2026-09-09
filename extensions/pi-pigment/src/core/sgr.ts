/**
 * The SGR parameter grammar: the running style state (bg, fg, open
 * attributes) an ANSI stream reduces to, plus the batch reduction
 * (`ansiState`) the wrap walk's incremental tracking is verified against.
 * The grammar lives in ONE place — SgrState — so batch and incremental
 * consumers can never drift on parameter semantics.
 */

/** The ESC control character every ANSI escape sequence starts with. */
const ESC = "\u001b";

/** Match any SGR escape sequence, capturing its parameters. */
const ANSI_CAPTURE_RE = new RegExp(`${ESC}\\[([^m]*)m`, "g");

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
 * The running SGR state (bg, fg, open attributes) an ANSI stream reduces
 * to. wrapAnsi feeds every escape cell through `apply` so a break can
 * replay the state without re-scanning the row; `ansiState` runs the
 * same machine over a whole string.
 */
export class SgrState {
  private fg = "";
  private bg = "";
  private attrs = new Set<number>();

  /**
   * Apply one escape sequence in place.
   *
   * @param escapeText - A single `ESC[...m` sequence.
   * @returns Nothing.
   */
  apply(escapeText: string): void {
    // `ESC[m` (empty params) is a reset, same as `ESC[0m`.
    const params = (escapeText.slice(2, -1) || "0").split(";").map(Number);
    let i = 0;
    while (i < params.length) {
      const p = params[i] ?? 0;
      if (p === 0) {
        this.fg = "";
        this.bg = "";
        this.attrs.clear();
      } else if (p === 39) {
        this.fg = "";
      } else if (p === 49) {
        this.bg = "";
      } else if (p === 38 || p === 48) {
        // A color spec consumes its tail: `2;r;g;b` (truecolor) or `5;n`
        // (256-color); a bare 38/48 (malformed) consumes just itself.
        const kind = params[i + 1];
        const len = colorSpecLength(kind);
        const seq = `\u001b[${params.slice(i, i + len).join(";")}m`;
        if (p === 38) {
          this.fg = seq;
        } else {
          this.bg = seq;
        }
        i += len - 1;
      } else if (p === 22) {
        this.attrs.delete(1); // bold off (and dim off — 2)
        this.attrs.delete(2);
      } else if (p === 23) {
        this.attrs.delete(3); // italic off
      } else if (p === 24) {
        this.attrs.delete(4); // underline off
      } else if (p === 29) {
        this.attrs.delete(9); // strikethrough off
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
   * The sequences that re-open this state (bg, fg, attrs — ansiState's order).
   *
   * @returns The re-open sequences.
   */
  replay(): string {
    const attrSeqs = [...this.attrs].map((a) => `\u001b[${a}m`).join("");
    return this.bg + this.fg + attrSeqs;
  }
}

/**
 * The SGR sequences that re-open the final style (bg, fg, attrs).
 * ansiState starts each continuation line's style from where the line
 * above left it (stripped trailing space + merged SGR tails), so a token
 * broken mid-line keeps its style on the next. The batch reduction over
 * SgrState — the reference implementation the wrap walk's incremental
 * tracking is verified against.
 *
 * @param content - ANSI-styled text.
 * @returns The SGR sequences that re-open the final style (bg, fg, attrs).
 */
export function ansiState(content: string): string {
  const state = new SgrState();
  state.applySeq(content);
  return state.replay();
}
