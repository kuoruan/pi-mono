/**
 * Shared bench inputs: realistic ANSI lines, a full diff palette, and
 * paired word-diff source lines. The core and render bench files both
 * import from here so the measured inputs stay identical across them.
 */
import type { DiffPalette } from "#src/theme/palette.ts";

/** A representative highlighted code line: tokens with truecolor escapes. */
export const styledLine =
  "\x1b[38;2;218;112;214mconst\x1b[39m \x1b[38;2;156;220;254mrenderView\x1b[39m\x1b[38;2;171;178;191m(\x1b[39m\x1b[38;2;209;154;102m42\x1b[39m\x1b[38;2;171;178;191m)\x1b[39m \x1b[38;2;218;212;163;0.9m{\x1b[39m";

/** A plain ASCII line (the common case for source code). */
export const plainLine = "  const total = items.reduce((sum, item) => sum + item.price, 0);";

/** A CJK-carrying line (the case the column gate exists for). */
export const cjkLine = "  // 中文注释宽度按双列计算，确保不溢出行宽限制边界情况";

/**
 * A line with cluster content: a flag pair and a ZWJ family among ASCII
 * text (the case the cluster tier exists for — the two clusters draw as 2
 * columns each, but hold 4 and 11 code units).
 */
export const riskyLine =
  "  deploy \u{1f1fa}\u{1f1f8} \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} pipeline done";

/** The riskyLine skeleton in plain ASCII, for the in-group mechanism ratio. */
export const riskyLineAscii = "  deploy US family pipeline done";

/**
 * A gate-positive line that is nearly all single-code-point clusters: CJK
 * text with one combining mark at the end. The gate fires (marks are
 * cluster-forming) so the line takes the cluster walk, but every CJK code
 * point still measures by the fast rule — the split between "gate hit" and
 * "visibleWidth per cluster".
 */
export const cjkMarkLine = "  // 中文注释与一点组合标记\u0301";

/** A 150-line diff body (one frame's worth at the render budget). */
export const diffBody = Array.from({ length: 150 }, (_, i) => `${plainLine} // ${i}`).join("\n");

/** The full diff palette (the same escape shapes the derivation emits). */
export const diffPalette: DiffPalette = {
  bgBase: "\x1b[48;2;30;30;40m",
  rowReset: "\x1b[0m",
  bgRemoved: "\x1b[48;2;53;30;34m",
  bgAdded: "\x1b[48;2;41;53;52m",
  bgRemovedGutter: "\x1b[48;2;60;32;38m",
  bgAddedGutter: "\x1b[48;2;46;58;56m",
  bgRemovedWord: "\x1b[48;2;122;42;48m",
  bgAddedWord: "\x1b[48;2;56;102;88m",
  fgDim: "\x1b[38;2;110;110;110m",
  fgCode: "\x1b[38;2;150;225;190m",
  fgRemoved: "\x1b[38;2;235;150;150m",
  fgAdded: "\x1b[38;2;150;225;190m",
  fgContext: "\x1b[38;2;110;110;120m",
  fgGutter: "\x1b[38;2;110;110;110m",
  isLight: false,
  identity: "bench",
};

/** A paired old/new line with a few word-level changes (word-diff paths). */
export const wordOldLine = "const total = items.reduce((sum, item) => sum + item.price, 0);";
export const wordNewLine = "const result = items.reduce((acc, item) => acc + item.price, 0);";
