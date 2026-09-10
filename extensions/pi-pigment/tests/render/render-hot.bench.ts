/**
 * The per-frame render hot paths: wrapAnsi / diffRowFrame / injectBg /
 * word-diff pay per row of every diff view render. The cell-level costs
 * underneath them (measurePlain / iterateCells / SgrState) live in
 * tests/core/ansi-hot.bench.ts; inputs are shared through
 * #test/bench-fixtures.ts.
 *
 * Benchmarks live inside `test()` as the `bench` context fixture;
 * `.bench.ts` files are skipped by `vitest run` and measured via
 * `pnpm vitest bench`.
 *
 * Every benchmark folds its return value into a running sink so the
 * engine cannot eliminate the measured work (dead-code elimination).
 */
import { test } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import {
  diffRowFrame,
  injectBg,
  paintWordDiff,
  plainWordDiff,
  shouldEmphasize,
  shouldUseSplit,
  wordDiffAnalysis,
  wrapAnsi,
} from "#src/render/render-shared.ts";
import {
  cjkLine,
  diffBody,
  diffPalette,
  plainLine,
  styledLine,
  wordNewLine,
  wordOldLine,
} from "#test/bench-fixtures.ts";

// Bind the measured functions AND the shared inputs locally: vite's module
// runner wraps every imported binding in a getter, and at nanosecond scale
// a getter call inside the timed callback would dominate the measurement.
const _wrapAnsi = wrapAnsi;
const _diffRowFrame = diffRowFrame;
const _injectBg = injectBg;
const _wordDiffAnalysis = wordDiffAnalysis;
const _plainWordDiff = plainWordDiff;
const _paintWordDiff = paintWordDiff;
const _shouldEmphasize = shouldEmphasize;
const _shouldUseSplit = shouldUseSplit;
const _styledLine = styledLine;
const _plainLine = plainLine;
const _cjkLine = cjkLine;
const _diffBody = diffBody;
const _diffPalette = diffPalette;
const _wordOldLine = wordOldLine;
const _wordNewLine = wordNewLine;

/** A realistic split-eligible parsed diff (paired edits over 30 lines). */
const _splitDiff = parseDiff(
  Array.from({ length: 30 }, (_, i) => `const line${i} = compute(${i}, items, 42);`).join("\n"),
  Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0
      ? `const line${i} = compute(${i}, result, 42);`
      : `const line${i} = compute(${i}, items, 42);`,
  ).join("\n"),
  0,
);

// One module-level sink absorbs every measured return value: an unused
// result would let the engine eliminate the measured work entirely
// (dead-code elimination — pure functions like wrapAnsi inline and
// vanish once their result is dropped).
let sink = 0;

test("wrapAnsi (fits-width fast path)", async ({ bench }) => {
  await bench("plain ASCII line at width 160 (pad only)", () => {
    sink += _wrapAnsi(_plainLine, {
      width: 160,
      maxRows: 4,
      fillBg: "",
      palette: _diffPalette,
    }).length;
  }).run();
});

test("wrapAnsi (real wrap)", async ({ bench }) => {
  await bench("styled line x4 wrapped at 40 cols (breaks + SGR state)", () => {
    sink += _wrapAnsi(_styledLine.repeat(4), {
      width: 40,
      maxRows: 4,
      fillBg: _diffPalette.bgBase,
      palette: _diffPalette,
    }).length;
  }).run();
});

test("wrapAnsi (CJK double-width squeeze)", async ({ bench }) => {
  await bench("CJK line at width 20 (wide-cell breaks + fill)", () => {
    sink += _wrapAnsi(_cjkLine, {
      width: 20,
      maxRows: 6,
      fillBg: _diffPalette.bgBase,
      palette: _diffPalette,
    }).length;
  }).run();
});

test("wrapAnsi (overflow truncation)", async ({ bench }) => {
  await bench("150-line body at width 60, budget 3 (last-row › marker)", () => {
    sink += _wrapAnsi(_diffBody, {
      width: 60,
      maxRows: 3,
      fillBg: _diffPalette.bgBase,
      palette: _diffPalette,
    }).length;
  }).run();
});

test("wrapAnsi (plain body, one wrap per line)", async ({ bench }) => {
  const lines = _diffBody.split("\n");
  await bench("150 plain lines at width 60 (per-line wrap)", () => {
    for (const line of lines) {
      sink += _wrapAnsi(line, {
        width: 60,
        maxRows: 3,
        fillBg: "",
        palette: _diffPalette,
      }).length;
    }
  }).run();
});

test("diffRowFrame (the per-row frame both views compose)", async ({ bench }) => {
  await bench("deleted row (sign + gutter + borders)", () => {
    sink += _diffRowFrame({
      type: "del",
      number: 12,
      numberWidth: 3,
      palette: _diffPalette,
      indicatorGlyph: "│",
    }).gutter.length;
  }).run();
  await bench("added row (change-sign fore/backgrounds)", () => {
    sink += _diffRowFrame({
      type: "add",
      number: 9,
      numberWidth: 3,
      palette: _diffPalette,
      indicatorGlyph: "│",
    }).gutter.length;
  }).run();
  await bench("context row (blank number cell)", () => {
    sink += _diffRowFrame({
      type: "ctx",
      number: null,
      numberWidth: 2,
      palette: _diffPalette,
      indicatorGlyph: "",
    }).gutter.length;
  }).run();
});

test("injectBg (the bg layer under every highlighted line)", async ({ bench }) => {
  await bench("styled line, no ranges (plain highlight)", () => {
    sink += _injectBg(_styledLine, { baseBg: _diffPalette.bgBase, palette: _diffPalette }).length;
  }).run();
  await bench("styled line with 2 emphasis ranges (word-diff paint)", () => {
    sink += _injectBg(_styledLine, {
      baseBg: _diffPalette.bgBase,
      highlightBg: _diffPalette.bgAddedWord,
      ranges: [
        [2, 12],
        [16, 26],
      ],
      palette: _diffPalette,
    }).length;
  }).run();
  await bench("plain line, no escapes (no-op scan)", () => {
    sink += _injectBg(_plainLine, { baseBg: _diffPalette.bgBase, palette: _diffPalette }).length;
  }).run();
});

test("word-diff pair (the fallback/unhighlighted analysis)", async ({ bench }) => {
  await bench("wordDiffAnalysis (range extraction)", () => {
    sink += _wordDiffAnalysis(_wordOldLine, _wordNewLine).similarity;
  }).run();
  await bench("plainWordDiff (jsdiff + paint)", () => {
    const result = _plainWordDiff(_wordOldLine, _wordNewLine, _diffPalette);
    sink += result.old.length + result.new.length;
  }).run();
  // The pre-optimization baseline the one-pass sequence replaced: analyze
  // (diffWords) THEN paint via plainWordDiff (a SECOND diffWords on the
  // same pair). Kept alongside so the A/B is self-contained in this file.
  await bench("old two-pass sequence (wordDiffAnalysis + plainWordDiff)", () => {
    const analysis = _wordDiffAnalysis(_wordOldLine, _wordNewLine);
    sink += analysis.similarity;
    if (_shouldEmphasize(analysis)) {
      const painted = _plainWordDiff(_wordOldLine, _wordNewLine, _diffPalette);
      sink += painted.old.length + painted.new.length;
    }
  }).run();
});

test("unified plain path per pair (the over-budget fallback sequence)", async ({ bench }) => {
  // Mirrors render-unified's per-pair sequence when the highlight budget
  // is exceeded: the verdict (wordDiffAnalysis) gates the plain painter,
  // and the painter consumes the analysis's parts — one diffWords per
  // pair (plainWordDiff, the standalone two-pass form, is benched above).
  await bench("verdict + paintWordDiff (one diffWords per pair)", () => {
    const analysis = _wordDiffAnalysis(_wordOldLine, _wordNewLine);
    sink += analysis.similarity;
    if (_shouldEmphasize(analysis)) {
      const painted = _paintWordDiff(analysis.parts, _diffPalette);
      sink += painted.old.length + painted.new.length;
    }
  }).run();
});

test("shouldUseSplit (the split/unified verdict per diff render)", async ({ bench }) => {
  // One call per committed diff-preview render: the verdict walks the
  // visible window's content lines (measurePlain(expandTabs(x)) each).
  // Pinned because a task render computes it TWICE today (seedBudget +
  // view choice) — the duplicate call is the cost this measures.
  await bench("split verdict over a 30-line window", () => {
    sink += _shouldUseSplit(_splitDiff, 120, 40) ? 1 : 0;
  }).run();
});
