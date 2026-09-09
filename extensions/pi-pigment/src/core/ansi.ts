/**
 * The ANSI text toolkit: escape production (forced truecolor — the renderers'
 * output is the final rendering contract, so NO_COLOR/FORCE_COLOR must not
 * affect diff rendering), inert-text sanitization (ADR 0004), and cell
 * geometry (measurement, truncation, wrapping). Everything here is a pure
 * function of its arguments; pure color math (RGB/hex/WCAG) lives in
 * color.ts; palette-dependent helpers stay in palette.ts.
 */

import type { RgbColor } from "@earendil-works/pi-tui";
import { Ansis } from "ansis";
import { eastAsianWidth } from "get-east-asian-width";

import { mixRgb } from "./color.ts";

/** The ESC control character every ANSI escape sequence starts with. */
const ESC = "\u001b";

/** Match any SGR escape sequence (parameters + "m"). */
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** Match any SGR escape sequence, capturing its parameters. */
const ANSI_CAPTURE_RE = new RegExp(`${ESC}\\[([^m]*)m`, "g");
/** Truecolor-only color factory (level 3, ignoring NO_COLOR/FORCE_COLOR). */
const color = new Ansis(3);

/** The SGR reset sequence. */
export const RESET = "\u001b[0m";

/** The SGR sequence resetting the background to the terminal default. */
export const BG_DEFAULT = "\x1b[49m";

/** The SGR sequence resetting the foreground to the terminal default. */
export const FG_DEFAULT = "\x1b[39m";

/** The dim style's opening escape. */
export const DIM = "\x1b[2m";

/**
 * Build a truecolor fg SGR escape.
 *
 * @param rgb - The color to encode.
 * @returns The `38;2;r;g;b` escape.
 */
export function fgRgb(rgb: RgbColor): string {
  return color.rgb(rgb.r, rgb.g, rgb.b).open;
}

/**
 * Build a truecolor bg SGR escape.
 *
 * @param rgb - The color to encode.
 * @returns The `48;2;r;g;b` escape.
 */
export function bgRgb(rgb: RgbColor): string {
  return color.bgRgb(rgb.r, rgb.g, rgb.b).open;
}

/**
 * Blend `accent` into `base` at `intensity` (0 = base, 1 = accent), as a bg SGR.
 *
 * @param base - The background to blend into.
 * @param accent - The foreground color being blended in.
 * @param intensity - Blend factor in [0, 1].
 * @returns The blended bg SGR escape.
 */
export function mixBg(base: RgbColor, accent: RgbColor, intensity: number): string {
  return bgRgb(mixRgb(base, accent, intensity));
}

/**
 * Remove all SGR escape sequences.
 *
 * @param content - ANSI-styled text.
 * @returns The text with escapes removed.
 */
export function stripAnsi(content: string): string {
  return content.replace(ANSI_RE, "");
}

/**
 * Expand tabs to two spaces (the renderer's tab width).
 *
 * @param content - Text possibly containing tabs.
 * @returns The text with tabs expanded.
 */
export function expandTabs(content: string): string {
  return content.replace(/\t/g, "  ");
}

// ---------------------------------------------------------------------------
// Inert text (terminal-injection defense; ADR 0004)
// ---------------------------------------------------------------------------

/**
 * Neutralize terminal control interpretation in user data (cat -v
 * semantics): every control character the terminal might act on becomes a
 * visible caret representation — ESC → `^[`, CR → `^M`, DEL → `^?`, C1
 * code points → their C0-equivalent caret. Display is honest (the file
 * really contains these bytes) and inert (they can only produce glyphs,
 * never sequence interpretation — no OSC 52 clipboard writes, no CSI
 * repositioning, no CR column overwrites).
 *
 * Tab and newline pass through untouched (expandTabs owns tabs; line
 * splitting owns newlines — the write path inerts whole multi-line
 * content, so \n inside the string is structure, not payload). Text
 * without control characters returns as-is — the zero-allocation fast
 * path source files almost always take.
 *
 * @param text - User data entering the render pipeline.
 * @returns The same text, unable to trigger terminal control sequences.
 */
export function inertText(text: string): string {
  let clean = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isControlCode(code)) {
      clean = false;
      break;
    }
  }
  if (clean) return text;
  return Array.from(text)
    .map((ch) => {
      // charCodeAt (the first code unit) is sufficient here: the C0/C1/DEL
      // mapping only consults code points below 0xa0, where UTF-16 code
      // units and code points coincide.
      const code = ch.charCodeAt(0);
      // C1 maps to its C0 equivalent (0x9b ≡ CSI ≡ ESC+[): the same caret
      // representation, so the rule stays total across both blocks. DEL's
      // caret char is "?" (its low six bits, per cat -v).
      const c0 = code >= 0x80 && code <= 0x9f ? code - 0x80 : code;
      if (!isControlCode(code)) return ch;
      return c0 === 0x7f ? "^?" : `^${String.fromCharCode(c0 + 0x40)}`;
    })
    .join("");
}

/**
 * Whether a code point is a terminal control character needing inerting.
 *
 * @param code - The code point to test.
 * @returns True for C0 (except tab/newline), DEL, and C1.
 */
function isControlCode(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f)
  );
}

// ---------------------------------------------------------------------------
// Terminal width measurement (code-point aware, east-asian double-width)
// ---------------------------------------------------------------------------

/**
 * Whether a code point renders two terminal columns — the same measure
 * pi-tui applies when wrapping: the Unicode East Asian Width database
 * (W and F classes) plus the regional-indicator special case (flags: often
 * full-width even when isolated, and pi-tui counts them conservatively as
 * 2). The database comes from get-east-asian-width, pi-tui's own source,
 * so drift between our wrapping and the TUI's is impossible by construction.
 *
 * @param codePoint - The Unicode code point.
 * @returns True when the code point is double-width.
 */
function isWideCodePoint(codePoint: number): boolean {
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return true; // regional indicators
  return eastAsianWidth(codePoint) === 2;
}

/**
 * One segment of an ANSI string: an SGR escape sequence (zero width) or a
 * single code point (one visible character, one or two columns). The unit
 * every width-aware walk of styled text consumes.
 */
export interface Cell {
  /** The segment's source span, in code units [start, end). */
  start: number;
  end: number;
  /** The segment's text. */
  text: string;
  /** Visible columns: 0 for escapes, 1–2 for code points. */
  cols: number;
  /** Visible characters: 1 for code points, 0 for escapes. */
  chars: number;
  /** True when the segment is an SGR escape sequence. */
  escape: boolean;
}

/**
 * Iterate an ANSI string by cell: each SGR escape yields whole (free — no
 * columns, no visible character), each code point yields with its column
 * count (East-Asian wide and regional indicators count 2). The one
 * primitive every styled-text walk consumes — wrapping, fitting,
 * background injection, and measurement all speak this unit, so
 * span-alignment and wide-character bugs have one place to live.
 *
 * `ESC[...m` is the only escape shape recognized (the SGR grammar the
 * rest of this module emits); a lone ESC without a terminating `m` yields
 * as a single code point.
 *
 * @param s - The ANSI-styled text.
 * @yields The cells, left to right.
 */
export function* iterateCells(s: string): Generator<Cell> {
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        yield {
          start: i,
          end: end + 1,
          text: s.slice(i, end + 1),
          cols: 0,
          chars: 0,
          escape: true,
        };
        i = end + 1;
        continue;
      }
    }
    const codePoint = s.codePointAt(i) ?? s.charCodeAt(i);
    const len = codePoint > 0xffff ? 2 : 1;
    yield {
      start: i,
      end: i + len,
      text: s.slice(i, i + len),
      cols: isWideCodePoint(codePoint) ? 2 : 1,
      chars: 1,
      escape: false,
    };
    i += len;
  }
}

/**
 * Truncate ANSI content to a visual width, padding short content with spaces
 * and appending a dimmed continuation marker when truncated. `reset` closes
 * dangling sequences; `fgDim` colors the marker.
 *
 * @param content - ANSI-styled text.
 * @param width - Target visual width.
 * @param reset - Reset escape closing dangling sequences.
 * @param fgDim - Dim fg escape for the continuation marker.
 * @returns The fitted text, exactly `width` visual columns.
 */
export function fitAnsi(content: string, width: number, reset: string, fgDim: string): string {
  if (width <= 0) return "";
  const columns = measurePlain(content);
  if (columns <= width) {
    return content + " ".repeat(width - columns);
  }
  const showWidth = width > 2 ? width - 1 : width;
  let kept = 0;
  let shown = 0;
  // Consume-before-check (wrapAnsi's rule): a wide code point that would
  // cross the boundary is left out entirely — then pad to the show budget
  // so the row stays at EXACTLY `width` columns (the marker takes one).
  for (const cell of iterateCells(content)) {
    if (cell.escape || shown + cell.cols <= showWidth) {
      kept = cell.end;
      shown += cell.cols;
    } else break;
  }
  const pad = " ".repeat(Math.max(0, showWidth - shown));
  return width > 2
    ? `${content.slice(0, kept)}${reset}${pad}${fgDim}›${reset}`
    : `${content.slice(0, kept)}${reset}`;
}

/**
 * The visual width of styled or plain text, in terminal columns (escape
 * sequences are free).
 *
 * @param content - The text.
 * @returns The column count.
 */
export function measurePlain(content: string): number {
  // Fast path: pure printable ASCII is one column per character — no cell
  // iteration (each yielded cell is an object allocation; a diff body of
  // plain lines would pay one per character). Anything else (escapes,
  // non-ASCII, wide code points) takes the precise walk.
  if (/^[\x20-\x7e]*$/.test(content)) return content.length;
  let columns = 0;
  for (const cell of iterateCells(content)) columns += cell.cols;
  return columns;
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
 * The SGR sequences that re-open the final style (bg, fg, attrs).
 * ansiState starts each continuation line's style from where the line
 * above left it (stripped trailing space + merged SGR tails), so a token
 * broken mid-line keeps its style on the next.
 *
 * @param content - ANSI-styled text.
 * @returns The SGR sequences that re-open the final style (bg, fg, attrs).
 */
export function ansiState(content: string): string {
  let fg = "";
  let bg = "";
  const attrs = new Set<number>();
  for (const match of content.matchAll(ANSI_CAPTURE_RE)) {
    // `ESC[m` (empty params) is a reset, same as `ESC[0m`.
    const params = (match[1] || "0").split(";").map(Number);
    let i = 0;
    while (i < params.length) {
      const p = params[i] ?? 0;
      if (p === 0) {
        fg = "";
        bg = "";
        attrs.clear();
      } else if (p === 39) {
        fg = "";
      } else if (p === 49) {
        bg = "";
      } else if (p === 38 || p === 48) {
        // A color spec consumes its tail: `2;r;g;b` (truecolor) or `5;n`
        // (256-color); a bare 38/48 (malformed) consumes just itself.
        const kind = params[i + 1];
        const len = colorSpecLength(kind);
        const seq = `\u001b[${params.slice(i, i + len).join(";")}m`;
        if (p === 38) {
          fg = seq;
        } else {
          bg = seq;
        }
        i += len - 1;
      } else if (p === 22) {
        attrs.delete(1); // bold off (and dim off — 2)
        attrs.delete(2);
      } else if (p === 23) {
        attrs.delete(3); // italic off
      } else if (p === 24) {
        attrs.delete(4); // underline off
      } else if (p === 29) {
        attrs.delete(9); // strikethrough off
      } else if (p >= 1 && p <= 9) {
        attrs.add(p);
      }
      i++;
    }
  }
  const attrSeqs = [...attrs].map((a) => `\u001b[${a}m`).join("");
  return bg + fg + attrSeqs;
}
