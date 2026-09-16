/**
 * The ANSI text toolkit: escape production (forced truecolor — the renderers'
 * output is the final rendering contract, so NO_COLOR/FORCE_COLOR must not
 * affect diff rendering), inert-text sanitization (ADR 0004), and cell
 * geometry (measurement, truncation, wrapping). Everything here is a pure
 * function of its arguments; pure color math (RGB/hex/WCAG) lives in
 * color.ts; palette-dependent helpers stay in palette.ts.
 */

import { visibleWidth, type RgbColor } from "@earendil-works/pi-tui";
import { Ansis } from "ansis";
import { eastAsianWidth } from "get-east-asian-width";

import { createBoundedFifoMap } from "./bounded-map.ts";
import { mixRgb } from "./color.ts";

/** Printable ASCII code units — the width fast-path gate. */
const PLAIN_ASCII_RE = /^[\x20-\x7e]*$/;
/** Truecolor-only color factory (level 3, ignoring NO_COLOR/FORCE_COLOR). */
const color = new Ansis(3);

/** The ESC control character every ANSI escape sequence starts with. */
export const ESC = "\u001b";

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
 * Expand tabs to two spaces (the renderer's tab width).
 *
 * @param content - Text possibly containing tabs.
 * @returns The text with tabs expanded.
 */
export function expandTabs(content: string): string {
  // Fast path: no tab means the same string reference — the hot wrap
  // paths (shouldUseSplit's measure and every row wrap) avoid allocating
  // a copy per line.
  return content.includes("\t") ? content.replace(/\t/g, "  ") : content;
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
// Terminal width measurement (two tiers: code points, then grapheme clusters)
// ---------------------------------------------------------------------------

/**
 * Whether a code point renders two terminal columns on its own — the East
 * Asian Width database (W and F classes) plus the regional-indicator special
 * case. This is the fast tier's rule, and it holds for pi-tui too whenever a
 * code point forms a cluster by itself; such code points are why a line of
 * plain text or CJK still needs no cluster walk. What it cannot see is a
 * cluster: two half-width-looking code points that draw as one two-column
 * flag, or a mark that adds nothing to the base it attaches to.
 *
 * @param codePoint - The Unicode code point.
 * @returns True when the code point is double-width.
 */
function isWideCodePoint(codePoint: number): boolean {
  // Exhaustively verified: no W/F code point exists below U+1100, so the
  // database lookup is skipped for every code point the fast tier meets in
  // plain/ASCII text (measured ~37ns per call on ASCII — the bulk of the
  // walk's cost on the common line; measured 1.6-1.9x whole-walk gain).
  if (codePoint < 0x1100) return false;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return true; // regional indicators
  return eastAsianWidth(codePoint) === 2;
}

/**
 * The code points that can reshape a line into grapheme clusters — the ones
 * where the fast per-code-point tier and pi-tui's cluster tier disagree:
 * combining, spacing, and enclosing marks of every script (\p{M}), format
 * characters such as ZWJ and the variation selectors (\p{Cf}), lone
 * surrogates (\p{Cs}), default-ignorable code points (jamo fillers among
 * them), emoji skin-tone modifiers, conjoining Hangul jamo, and the regional
 * indicators (a flag is ONE cluster of two).
 *
 * Control characters are deliberately absent: ESC is one, and every escape
 * this module emits starts with it, so including them would send every
 * styled line to the cluster walk. `inertText` owns C0/C1/DEL and
 * `expandTabs` owns the tab, so neither reaches measurement.
 *
 * The property classes above miss a tail of code points that join a
 * neighbour into one cluster while being categorized as ordinary letters:
 * the GCB=Prepend code points (a Prepend attaches to the FOLLOWING base)
 * and the GCB=SpacingMark ones (Thai/Lao SARA AM, the halfwidth katakana
 * voiced marks, which extend the PRECEDING kana). The fast tier both
 * measures some of them wrong (U+0D4E: one column where the cluster is
 * none) and — for all of them — lets a wrap break between the two members
 * of a cluster that must stay whole. The tail was derived exhaustively
 * rather than copied from a chart: for every code point, ask
 * Intl.Segmenter whether `"a" + cp` or `cp + "a"` forms ONE cluster, then
 * subtract everything the classes above already match. Re-run that probe
 * after a Unicode bump — the classes track the runtime's tables, this
 * tail does not. `tools/sync-risky-tail.ts` re-derives and checks it
 * (`--write` updates in place); the exhaustive sweep takes ~10s, so CI
 * carries only the BMP sweep in grapheme-clusters.test.ts.
 */
// sync-risky-tail:begin
const RISKY_CODE_POINT_RE =
  /[\p{M}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Emoji_Modifier}\u{1100}-\u{11ff}\u{1f1e6}-\u{1f1ff}\u{d4e}\u{e33}\u{eb3}\u{a960}-\u{a97c}\u{d7b0}-\u{d7c6}\u{d7cb}-\u{d7fb}\u{ff9e}-\u{ff9f}\u{111c2}-\u{111c3}\u{113d1}\u{1193f}\u{11941}\u{11a84}-\u{11a89}\u{11d46}\u{11f02}\u{16d63}\u{16d67}-\u{16d6a}]/u;
// sync-risky-tail:end

/**
 * The per-cell visitor `forEachCell` calls: the cell's span (`start`
 * inclusive, `end` exclusive), its terminal columns (0 for escapes), and
 * whether it is an escape. Return `true` to stop the walk. The cell's text
 * is deliberately not handed over — slice `s.slice(start, end)` at the call
 * site only when it is needed, so measure-only walks never allocate.
 */
export type CellVisitor = (
  start: number,
  end: number,
  cols: number,
  isEscape: boolean,
) => boolean | void;

/** Capacity of the gate-verdict memo, in lines. */
const GATE_MEMO_CAPACITY = 512;

/**
 * Memoized gate verdicts. The property scan costs ~13ns per code point
 * (a 60-column CJK line scanned ~880ns), against a verdict that is a pure
 * function of the line and lines a TUI re-measures every frame (pi-tui
 * keeps its width results in a bounded cache for the same reason). Exact
 * FIFO: recency says nothing about a pure verdict, so the read stays one
 * plain `Map.get` (measured ~13ns against ~60ns for a recency touch on
 * the same keys) and the oldest line simply leaves first.
 */
const riskyLineMemo = createBoundedFifoMap<string, boolean>(GATE_MEMO_CAPACITY);

/**
 * Whether a line carries a code point that can reshape it into clusters.
 *
 * @param s - The ANSI-styled line.
 * @returns True when the line must be walked by grapheme cluster.
 */
function hasRiskyCodePoint(s: string): boolean {
  const memo = riskyLineMemo.get(s);
  if (memo !== undefined) return memo;
  const risky = RISKY_CODE_POINT_RE.test(s);
  riskyLineMemo.set(s, risky);
  return risky;
}

/** The grapheme segmenter the cluster tier uses, built at first gated line. */
let graphemeSegmenter: Intl.Segmenter | undefined;

/**
 * The end of the escape sequence starting at `i`, or -1 when there is none.
 * Callers guard on `s[i] === ESC`.
 *
 * The escape grammar, in its one home: `ESC[...m` (SGR — the only shape this
 * module emits) and OSC (the 8;; hyperlinks the header writes), whose cell
 * runs to the BEL or ST terminator so a URL's characters are never
 * escape-cell boundaries (an "m" in a path must not split the sequence).
 * Both cell tiers walk through it, and `reinjectSgr`'s batch scan consumes
 * the same shapes rather than keeping a second copy of them.
 *
 * @param s - The ANSI-styled text.
 * @param i - Index of the ESC.
 * @returns The exclusive end of the escape, or -1 for a lone ESC.
 */
export function escapeEndAt(s: string, i: number): number {
  const kind = s[i + 1];
  if (kind === "[") {
    const end = s.indexOf("m", i);
    return end === -1 ? -1 : end + 1;
  }
  if (kind === "]") {
    const bel = s.indexOf("\u0007", i);
    const st = s.indexOf(ESC + "\\", i);
    if (bel !== -1 && (st === -1 || bel < st)) return bel + 1;
    if (st !== -1) return st + 2;
  }
  return -1;
}

/**
 * Visit the cell at an ESC, in either tier: the whole escape when one is
 * recognized, otherwise the lone ESC — text by this module's grammar, one
 * column in both tiers' agreement.
 *
 * @param s - The ANSI-styled text.
 * @param i - Index of the ESC.
 * @param visit - The walk's visitor.
 * @returns The index after the cell, or -1 when the visitor stopped the walk.
 */
function stepEscape(s: string, i: number, visit: CellVisitor): number {
  const end = escapeEndAt(s, i);
  if (end !== -1) {
    if (visit(i, end, 0, true)) return -1;
    return end;
  }
  return visit(i, i + 1, 1, false) ? -1 : i + 1;
}

/**
 * Walk an ANSI string by cell: each SGR escape visits whole (free — no
 * columns, no visible character), each visible unit visits with its column
 * count. The one primitive every styled-text walk consumes — wrapping,
 * fitting, background injection, and measurement all speak this unit, so
 * span-alignment and wide-character bugs have one place to live.
 *
 * Visible units are code points, except on a line carrying cluster-forming
 * code points (marks, format characters, emoji ZWJ sequences and modifiers,
 * conjoining jamo, regional-indicator flags): there a unit is a grapheme
 * cluster, whose columns come from pi-tui's own `visibleWidth`. The renderer
 * draws clusters, so it decides their width — and because the authority is
 * called rather than copied, a width rule it changes upstream reaches us for
 * free. A cluster's span covers all of its code units and a wrap may only
 * break between cells, so no cluster is ever cut in half.
 *
 * `ESC[...m` is the only escape shape recognized (the SGR grammar the
 * rest of this module emits); a lone ESC without a terminating `m` visits
 * as a single code point.
 *
 * The visitor takes primitives instead of a `Cell` record: the generator
 * form allocated one object per cell and measured 3–8x its inlined
 * equivalent on the same input (the allocation, not the escape scan, was
 * the bulk), while this shape matches the inlined walk. A visitor also
 * cannot be retained by accident — the record-reuse alternative measured
 * *slower* than the allocation it removed.
 *
 * @param s - The ANSI-styled text.
 * @param visit - Called per cell; see `CellVisitor` for the contract.
 */
export function forEachCell(s: string, visit: CellVisitor): void {
  if (hasRiskyCodePoint(s)) {
    forEachClusterCell(s, visit);
    return;
  }
  forEachCodePointCell(s, visit);
}

/**
 * The fast tier: one cell per code point (East-Asian wide and regional
 * indicators count two columns). Exact for every line without
 * cluster-forming code points, which is every line the gate lets through.
 *
 * @param s - The ANSI-styled text.
 * @param visit - The walk's visitor.
 */
function forEachCodePointCell(s: string, visit: CellVisitor): void {
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const next = stepEscape(s, i, visit);
      if (next === -1) return;
      i = next;
      continue;
    }
    const codePoint = s.codePointAt(i) ?? s.charCodeAt(i);
    const len = codePoint > 0xffff ? 2 : 1;
    if (visit(i, i + len, isWideCodePoint(codePoint) ? 2 : 1, false)) return;
    i += len;
  }
}

/**
 * The cluster tier: escapes visit exactly as in the fast tier, and every
 * text run between escapes is segmented into grapheme clusters, each
 * visiting as one cell.
 *
 * Runs are sliced at the next ESC because the segmenter must never see
 * escape bytes — a Control breaks clusters, so an escape would be shredded
 * into cells.
 *
 * @param s - The ANSI-styled text.
 * @param visit - The walk's visitor.
 */
function forEachClusterCell(s: string, visit: CellVisitor): void {
  const segmenter = (graphemeSegmenter ??= new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }));
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const next = stepEscape(s, i, visit);
      if (next === -1) return;
      i = next;
      continue;
    }
    const nextEscape = s.indexOf(ESC, i);
    const runEnd = nextEscape === -1 ? s.length : nextEscape;
    let at = i;
    for (const { segment } of segmenter.segment(s.slice(i, runEnd))) {
      const end = at + segment.length;
      if (visit(at, end, clusterColumns(segment), false)) return;
      at = end;
    }
    i = runEnd;
  }
}

/**
 * Columns of one grapheme cluster.
 *
 * A cluster that is a single code point and forms no cluster measures the
 * same either way, so it keeps the fast rule — that is what spares pi-tui's
 * width cache the plain ASCII and CJK code points of a gated line, leaving
 * it to the genuinely clustered content. Everything else is measured by
 * pi-tui itself.
 *
 * @param cluster - One grapheme cluster.
 * @returns Column count.
 */
function clusterColumns(cluster: string): number {
  const codePoint = cluster.codePointAt(0) ?? 0;
  if (
    cluster.length === (codePoint > 0xffff ? 2 : 1) &&
    (codePoint < 0x80 || !RISKY_CODE_POINT_RE.test(cluster))
  ) {
    return isWideCodePoint(codePoint) ? 2 : 1;
  }
  return visibleWidth(cluster);
}

/**
 * The truncating row's content budget: the marker's column when the width can
 * spare one, the full width below that. One clamp for every truncating site,
 * so the rule cannot drift between them.
 *
 * @param width - The row's exact width.
 * @returns The content budget in columns.
 */
export function truncateBudget(width: number): number {
  return width > 2 ? width - 1 : width;
}

/**
 * The truncated row's marker tail: the dimmed `›` closed by reset — one
 * definition so the marker's bytes have one home. Callers at width ≤ 2
 * (no room to draw one) omit it.
 *
 * @param reset - The reset closing the row.
 * @param fgDim - The dim fg escape coloring the marker.
 * @returns The marker tail escape run.
 */
export function continuationTail(reset: string, fgDim: string): string {
  return `${fgDim}›${reset}`;
}

/**
 * Count code points (not UTF-16 code units) in `text[start, end)` — the unit
 * the word-diff ranges are produced in.
 *
 * @param text - The text to count in.
 * @param start - The first code unit (default 0).
 * @param end - One past the last code unit (default the string end).
 * @returns The code-point count.
 */
export function codePointCount(text: string, start = 0, end: number = text.length): number {
  let count = 0;
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    // A high surrogate pairs ONLY with a following low surrogate (one
    // code point, two units); a lone high surrogate counts as one —
    // UTF-8 decode never produces one, but the total stays right on
    // every input class.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < end) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
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
  // Plain path: printable ASCII truncates by slicing (one column per code
  // unit; the marker row's content budget is width-1, and a plain line
  // always fills it exactly, so the pad is zero).
  if (isPlainAscii(content)) {
    if (content.length <= width) return content + " ".repeat(width - content.length);
    const shown = content.slice(0, truncateBudget(width));
    return width > 2 ? `${shown}${reset}${continuationTail(reset, fgDim)}` : `${shown}${reset}`;
  }
  // Non-plain: ONE walk serves both outcomes — it follows the fit budget
  // (`width`) as the consume-before-check limit and, in parallel, keeps
  // the truncation prefix (budget width-1, the marker's column). A cell
  // that breaks the fit budget proves content remains: return the
  // truncation prefix. Completing the walk proves the content fits.
  const showWidth = truncateBudget(width);
  let shown = 0; // columns under the fit budget
  let truncEnd = 0; // prefix end under the width-1 budget
  let truncShown = 0; // prefix columns (≤ showWidth)
  let truncated = false;
  forEachCell(content, (_start, end, cols, isEscape) => {
    if (!isEscape && shown + cols > width) {
      truncated = true;
      return true;
    }
    if (!isEscape) shown += cols;
    if (isEscape || truncShown + cols <= showWidth) {
      truncEnd = end;
      if (!isEscape) truncShown += cols;
    }
  });
  if (truncated) {
    // Below the marker's minimum width the row carries neither padding nor
    // a marker — the caller's own contract (fitAnsi's narrow form does not
    // pad to the width; wrap's does, in its own branch).
    if (width <= 2) return `${content.slice(0, truncEnd)}${reset}`;
    // No clamp: truncShown only advances while it stays ≤ showWidth.
    const pad = " ".repeat(showWidth - truncShown);
    return `${content.slice(0, truncEnd)}${reset}${pad}${continuationTail(reset, fgDim)}`;
  }
  return content + " ".repeat(width - shown);
}

/**
 * Whether every code unit is printable ASCII — the shared fast-path gate:
 * such text maps one column per code unit (no escapes to skip, no wide
 * code points), so measurement reduces to `.length` and wrapping reduces
 * to slicing.
 *
 * @param content - The text to test.
 * @returns True when only printable ASCII code units are present.
 */
export function isPlainAscii(content: string): boolean {
  return PLAIN_ASCII_RE.test(content);
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
  // iteration (a diff body of plain lines would pay one walk per line).
  // Anything else (escapes, non-ASCII, wide code points) takes the walk.
  if (isPlainAscii(content)) return content.length;
  let columns = 0;
  forEachCell(content, (_start, _end, cols) => {
    columns += cols;
  });
  return columns;
}
