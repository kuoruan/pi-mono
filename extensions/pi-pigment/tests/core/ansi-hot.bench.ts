/**
 * The ansi hot-path bench: measurePlain / wrapAnsi / iterateCells are the
 * per-line costs every diff view pays on its first render of a block (the
 * Text/Box caches amortize them across unchanged frames; the first wrap
 * and every width change pay full price). Baseline before optimizing; the
 * ASCII fast path in measurePlain lands against these numbers.
 */
import { bench, describe } from "vitest";

import { measurePlain } from "#src/core/ansi.ts";
import { wrapAnsi } from "#src/render/render-shared.ts";

/** A representative highlighted code line: tokens with truecolor escapes. */
const styledLine =
  "\x1b[38;2;218;112;214mconst\x1b[39m \x1b[38;2;156;220;254mrenderView\x1b[39m\x1b[38;2;171;178;191m(\x1b[39m\x1b[38;2;209;154;102m42\x1b[39m\x1b[38;2;171;178;191m)\x1b[39m \x1b[38;2;218;212;163;0.9m{\x1b[39m";

/** A plain ASCII line (the common case for source code). */
const plainLine = "  const total = items.reduce((sum, item) => sum + item.price, 0);";

/** A CJK-carrying line (the case the column gate exists for). */
const cjkLine = "  // 中文注释宽度按双列计算，确保不溢出行宽限制边界情况";

/** A 150-line diff body (one frame's worth at the render budget). */
const diffBody = Array.from({ length: 150 }, (_, i) => `${plainLine} // ${i}`).join("\n");

describe("measurePlain", () => {
  bench("styled code line (~120 cols with escapes)", () => {
    measurePlain(styledLine);
  });
  bench("plain ASCII line (80 chars)", () => {
    measurePlain(plainLine);
  });
  bench("CJK line (double-width cells)", () => {
    measurePlain(cjkLine);
  });
  bench("150-line diff body", () => {
    for (const line of diffBody.split("\n")) measurePlain(line);
  });
});

describe("wrapAnsi (fits-width fast path)", () => {
  bench("plain ASCII line at width 160 (pad only)", () => {
    wrapAnsi(plainLine, {
      width: 160,
      maxRows: 4,
      fillBg: "",
      palette: { bgBase: "\x1b[48;2;30;30;40m", rowReset: "\x1b[0m" } as never,
    });
  });
});

describe("wrapAnsi (real wrap)", () => {
  bench("styled line squeezed to 40 cols", () => {
    wrapAnsi(styledLine, {
      width: 40,
      maxRows: 4,
      fillBg: "\x1b[48;2;30;30;40m",
      palette: { bgBase: "\x1b[48;2;30;30;40m", rowReset: "\x1b[0m" } as never,
    });
  });
});
