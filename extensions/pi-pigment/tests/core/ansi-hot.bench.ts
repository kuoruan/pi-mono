/**
 * The ansi cell/line hot paths: measurePlain / iterateCells / ansiState
 * are the per-cell and per-line costs every diff view pays on its first
 * render of a block (the Text/Box caches amortize them across unchanged
 * frames; the first wrap and every width change pay full price). Baseline
 * before optimizing; the ASCII fast path in measurePlain lands against
 * these numbers. The frame-level render costs (wrapAnsi / diffRowFrame /
 * injectBg / word diff) live in tests/render/render-hot.bench.ts.
 *
 * Benchmarks live inside `test()` as the `bench` context fixture;
 * `.bench.ts` files are skipped by `vitest run` and measured via
 * `pnpm vitest bench`.
 *
 * Every benchmark folds its return value into a running sink so the
 * engine cannot eliminate the measured work (dead-code elimination).
 */
import { test } from "vitest";

import { ansiState, iterateCells, measurePlain } from "#src/core/ansi.ts";
import { cjkLine, diffBody, plainLine, styledLine } from "#test/bench-fixtures.ts";

// Bind the measured functions AND the shared inputs locally: vite's module
// runner wraps every imported binding in a getter, and at nanosecond scale
// a getter call inside the timed callback would dominate the measurement.
const _measurePlain = measurePlain;
const _iterateCells = iterateCells;
const _ansiState = ansiState;
const _styledLine = styledLine;
const _plainLine = plainLine;
const _cjkLine = cjkLine;
const _diffBody = diffBody;

// One module-level sink absorbs every measured return value: an unused
// result would let the engine eliminate the measured work entirely
// (dead-code elimination — pure functions like measurePlain inline and
// vanish once their result is dropped).
let sink = 0;

test("measurePlain", async ({ bench }) => {
  await bench("styled code line (~120 cols with escapes)", () => {
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

test("iterateCells", async ({ bench }) => {
  const walk = (line: string): void => {
    for (const cell of _iterateCells(line)) {
      if (!cell.escape) sink += cell.cols;
    }
  };
  await bench("styled code line (escape + token cells)", () => {
    walk(_styledLine);
  }).run();
  await bench("plain ASCII line", () => {
    walk(_plainLine);
  }).run();
  await bench("CJK line (wide-cell path)", () => {
    walk(_cjkLine);
  }).run();
});

test("ansiState (the wrap breakRow snapshot)", async ({ bench }) => {
  await bench("styled code line", () => {
    sink += _ansiState(_styledLine).length;
  }).run();
  await bench("plain ASCII line (no escapes)", () => {
    sink += _ansiState(_plainLine).length;
  }).run();
});
