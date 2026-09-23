/**
 * The ansi cell/line hot paths: measurePlain / forEachCell / SgrState
 * are the per-cell and per-line costs every diff view pays on its first
 * render of a block (the Text/Box caches amortize them across unchanged
 * frames; the first wrap and every width change pay full price). Baseline
 * before optimizing; the ASCII fast path in measurePlain lands against
 * these numbers. The frame-level render costs (wrapAnsi / diffRowFrame /
 * injectBg / word diff) live in tests/render/render-hot.bench.ts.
 *
 * The measurePlain / forEachCell groups are gate-negative inputs: they show
 * what the cluster gate costs a line that does NOT need it. The
 * "grapheme-cluster tier" group is the other side — the segmenter pass a
 * gated line pays.
 *
 * Benchmarks live inside `test()` as the `bench` context fixture;
 * `.bench.ts` files are skipped by `vitest run` and measured via
 * `pnpm vitest bench`.
 *
 * Every benchmark folds its return value into a running sink so the
 * engine cannot eliminate the measured work (dead-code elimination).
 */
import { expect, test } from "vitest";

import { fitAnsi, forEachCell, measurePlain } from "#src/core/ansi.ts";
import { SgrState } from "#src/core/sgr.ts";
import {
  LINE_WIDTH_SAMPLE,
  cjkLine,
  cjkMarkLine,
  diffBody,
  plainLine,
  riskyLine,
  riskyLineAscii,
  styledLine,
} from "#test/bench-fixtures.ts";

// Bind the measured functions AND the shared inputs locally: vite's module
// runner wraps every imported binding in a getter, and at nanosecond scale
// a getter call inside the timed callback would dominate the measurement.
const _measurePlain = measurePlain;
const _forEachCell = forEachCell;
const _fitAnsi = fitAnsi;
const _styledLine = styledLine;
const _plainLine = plainLine;
const _cjkLine = cjkLine;
const _cjkMarkLine = cjkMarkLine;
const _riskyLine = riskyLine;
const _riskyLineAscii = riskyLineAscii;
const _diffBody = diffBody;

// One module-level sink absorbs every measured return value: an unused
// result would let the engine eliminate the measured work entirely
// (dead-code elimination — pure functions like measurePlain inline and
// vanish once their result is dropped).
let sink = 0;

const walkForEachCell = (line: string): void => {
  _forEachCell(line, (_start, _end, cols, isEscape) => {
    if (!isEscape) sink += cols;
  });
};
/**
 * The line-width distribution the mixed-frame bench assumes (see
 * LINE_WIDTH_SAMPLE): the styledWidth widths must keep matching it, or
 * the fits-share the fits-gate threshold rests on silently ages. Fails
 * loudly on drift so a re-sample updates the fixture widths too.
 */
test("mixed-frame width distribution", () => {
  const widths = [
    22, 22, 22, 22, 22, 22, 32, 32, 32, 32, 32, 32, 32, 32, 32, 45, 45, 45, 45, 65, 65, 65, 65, 65,
    90, 130,
  ];
  const share = (pane: number): number => widths.filter((w) => w <= pane).length / widths.length;
  expect(Math.abs(share(36) - LINE_WIDTH_SAMPLE.fits36)).toBeLessThan(0.02);
  expect(Math.abs(share(56) - LINE_WIDTH_SAMPLE.fits56)).toBeLessThan(0.02);
  expect(Math.abs(share(76) - LINE_WIDTH_SAMPLE.fits76)).toBeLessThan(0.02);
});

test("measurePlain", async ({ bench }) => {
  await bench("styled code line (~25 cols with escapes)", () => {
    sink += _measurePlain(_styledLine);
  }).run();
  await bench("plain ASCII line (80 chars)", () => {
    sink += _measurePlain(_plainLine);
  }).run();
  await bench("CJK line (double-width cells)", () => {
    sink += _measurePlain(_cjkLine);
  }).run();
  await bench("150-line diff body", () => {
    for (const line of _diffBody.split("\n")) sink += _measurePlain(line);
  }).run();
});

test("forEachCell", async ({ bench }) => {
  await bench("styled code line (escape + token cells)", () => {
    walkForEachCell(_styledLine);
  }).run();
  await bench("plain ASCII line", () => {
    walkForEachCell(_plainLine);
  }).run();
  await bench("CJK line (wide-cell path)", () => {
    walkForEachCell(_cjkLine);
  }).run();
});

/**
 * The cell-walk SHAPE: the visitor primitive against a hand-inlined walk of the
 * same input with the same per-cell classification. The two must stay within
 * noise of each other — the point of the visitor is that it keeps the walk's
 * escape/wide-character logic in ONE place without paying for it. A widening gap
 * means the walk grew machinery again (its generator form measured 5-8x the
 * inlined walk, the per-cell object being the bulk), so treat a regression here
 * as a real one, not as bench jitter.
 */
test("cell-walk shape (visitor vs inlined: the two must move together)", async ({ bench }) => {
  await bench("forEachCell (the primitive)", () => {
    _forEachCell(_plainLine, (_start, _end, cols, isEscape) => {
      if (!isEscape) sink += cols;
    });
  }).run();
  await bench("inlined walk (no visitor call)", () => {
    // The same classification as the primitive's first step (ESC code unit).
    for (let i = 0; i < _plainLine.length; i++) if (_plainLine.charCodeAt(i) !== 27) sink += 1;
  }).run();
});

test("SgrState apply (the wrap walk's per-escape update)", async ({ bench }) => {
  const state = new SgrState();
  const tokenOpen = "\x1b[38;2;218;112;214m";
  const tokenClose = "\x1b[39m";
  await bench("apply a truecolor token open", () => {
    state.apply(tokenOpen);
    sink += state.replay().length;
  }).run();
  await bench("apply a fg-reset (39m)", () => {
    state.apply(tokenClose);
    sink += state.replay().length;
  }).run();
  await bench("applySeq seeding (state + fillBg)", () => {
    state.applySeq("\x1b[48;2;30;30;40m\x1b[1m");
    sink += state.replay().length;
  }).run();
});

const FIT_RESET = "\x1b[0m";
const FIT_DIM = "\x1b[38;2;110;110;110m";

/**
 * The cluster tier's price. The measurePlain / forEachCell groups above are
 * gate-NEGATIVE inputs (no mark, format character, emoji modifier, jamo or
 * flag): they carry the gate's own cost. This group measures the other
 * side. A gated line is walked by grapheme cluster, so it pays one
 * `Intl.Segmenter` pass plus a pi-tui `visibleWidth` call per genuinely
 * clustered span — 10–20x the fast walk on the same line length (measured),
 * which is why the gate exists and why it must stay narrow: a cluster the
 * walk cannot see (a flag split across rows) is worse than a slow rare
 * line, but a common line routed here would be a real regression (the
 * gate-negative CJK groups above stay at parity — that is the sentinel).
 */
test("grapheme-cluster tier (gated lines)", async ({ bench }) => {
  await bench("risky line (flag pair + ZWJ family): cluster walk", () => {
    sink += _measurePlain(_riskyLine);
  }).run();
  await bench("same skeleton in ASCII: fast walk", () => {
    sink += _measurePlain(_riskyLineAscii);
  }).run();
  await bench("gated but unclustered (CJK + one mark)", () => {
    sink += _measurePlain(_cjkMarkLine);
  }).run();
});

test("fitAnsi (truncation)", async ({ bench }) => {
  await bench("plain line truncated at width 40", () => {
    sink += _fitAnsi(_plainLine, 40, FIT_RESET, FIT_DIM).length;
  }).run();
  await bench("styled line truncated at width 16", () => {
    sink += _fitAnsi(_styledLine, 16, FIT_RESET, FIT_DIM).length;
  }).run();
});
