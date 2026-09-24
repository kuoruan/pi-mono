import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { fitAnsi, forEachCell, measurePlain } from "#src/core/ansi.ts";
import { SEQ_DIM, SEQ_RESET } from "#src/core/escapes.ts";
import { wrapAnsi } from "#src/render/wrap.ts";
import { FALLBACK_THEME } from "#src/theme/scheme.ts";
import { plain } from "#test/fixtures.ts";

/** The grapheme clusters of a string — the same segmentation pi-tui draws. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cluster = (s: string): string[] => [...segmenter.segment(s)].map((data) => data.segment);

/**
 * Content where the renderer's grapheme model and a per-code-point walk
 * disagree: a cluster is one cell (pi-tui measures it with Intl.Segmenter +
 * the string-width rules), while code points are what a fast walk sees.
 *
 * The expected column counts are pi-tui's own answers — every case also
 * asserts `measurePlain(s) === visibleWidth(s)`, so the table documents the
 * model rather than re-deriving it.
 */
const CLUSTER_CASES: ReadonlyArray<readonly [label: string, text: string, cols: number]> = [
  ["a flag pair", "\u{1f1fa}\u{1f1f8}", 2],
  ["two flags", "\u{1f1ef}\u{1f1f5}\u{1f1fa}\u{1f1f8}", 4],
  ["a lone regional indicator", "\u{1f1fa}", 2],
  ["three regional indicators (a flag plus a stray)", "\u{1f1fa}\u{1f1f8}\u{1f1ef}", 4],
  ["a ZWJ family", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}", 2],
  ["a skin-tone modifier sequence", "\u{1f44d}\u{1f3fd}", 2],
  ["a keycap sequence", "#\ufe0f\u20e3", 2],
  ["a VS16 emoji (heart)", "\u2764\ufe0f", 2],
  ["a tag sequence (flag)", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", 2],
  ["a base plus a combining mark", "e\u0301", 1],
  ["a lone combining mark", "\u0301", 0],
  ["a lone VS16", "\ufe0f", 0],
  ["a lone ZWJ", "\u200d", 0],
  ["a lone soft hyphen (format char)", "\u00ad", 0],
  ["conjoining jamo L+V+T", "\u1100\u1161\u11a8", 2],
  ["jamo fillers (default-ignorable)", "\u115f\u1160", 0],
  ["CJK plus a combining mark", "\u6f22\u0301", 2],
  ["decomposed kana (base plus a voicing mark)", "\u304b\u3099", 2],
  ["ASCII plus a spacing mark", "a\u0903", 2],
  ["a lone spacing mark", "\u0903", 1],
  ["a prepend character plus a base", "\u0600a", 1],
  ["a Thai AM vowel cluster", "\u0e01\u0e33", 2],
  ["a lone Thai AM vowel", "\u0e33", 1],
  ["a combining mark plus a fullwidth form", "\u0301\uff21", 2],
  ["a lone surrogate", String.fromCodePoint(0xd800), 0],
  ["ZWJ joining two ASCII letters", "a\u200db", 2],
  ["halfwidth katakana (no cluster at all)", "\uff8a\uff9b\uff70", 3],
  ["a flag pair inside SGR escapes", `\x1b[1m\u{1f1fa}\u{1f1f8}\x1b[0m done`, 7],
];

/**
 * Walk every code point of `ranges` paired with `pairOf(ch)` and report the
 * ones that do NOT come out as a single cell.
 *
 * @param ranges - Inclusive code point ranges to probe.
 * @param pairOf - Builds the two-code-point probe from one code point.
 * @returns One label per code point that failed to merge into one cell.
 */
function clusterProbe(ranges: Array<[number, number]>, pairOf: (ch: string) => string): string[] {
  const mismatches: string[] = [];
  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp++) {
      const pair = pairOf(String.fromCodePoint(cp));
      let cells = 0;
      forEachCell(pair, () => {
        cells += 1;
      });
      if (cells !== 1) mismatches.push(`U+${cp.toString(16)}: ${cells} cells`);
    }
  }
  return mismatches;
}

describe("the grapheme-cluster width model (measurement must equal the renderer)", () => {
  it("measures every BMP code point exactly as pi-tui does", () => {
    // The invariant this whole model exists for: what we measure is what
    // pi-tui draws. Cc (C0, DEL, C1) is out of scope — inertText owns control
    // characters and expandTabs owns the tab, so neither reaches measurement
    // in production (pi-tui measures both as zero-width).
    const mismatches: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint++) {
      if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
      const ch = String.fromCharCode(codePoint);
      const ours = measurePlain(ch);
      const theirs = visibleWidth(ch);
      if (ours !== theirs) {
        mismatches.push(
          `U+${codePoint.toString(16).toUpperCase()}: ours=${ours}, pi-tui=${theirs}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("measures cluster content exactly as pi-tui does", () => {
    const mismatches: string[] = [];
    for (const [label, text, cols] of CLUSTER_CASES) {
      const ours = measurePlain(text);
      if (ours !== cols || ours !== visibleWidth(text)) {
        mismatches.push(`${label}: ours=${ours}, table=${cols}, pi-tui=${visibleWidth(text)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("the cluster gate catches every BMP code point that joins its neighbour (regression)", () => {
    // The gate must route a line to the cluster tier whenever it carries a
    // code point that can merge two code points into ONE cell — with a
    // base (Extend/SpacingMark/ZWJ forms) or with what follows (GCB=
    // Prepend). Missing one leaves it to the fast tier, which both
    // mis-measures some of them (U+0D4E) and lets wrap/fit break BETWEEN
    // the members of a cluster. Expressed through the public cell walk:
    // for a joiner, a two-code-point pair is ONE cell. The astral tail of
    // joiners is covered by the explicit pairs in the next test — derive
    // it with an exhaustive Intl.Segmenter probe after a Unicode bump.
    const misses: string[] = [];
    for (let codePoint = 0x20; codePoint <= 0xffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const ch = String.fromCharCode(codePoint);
      const joins =
        cluster("a" + ch).length === 1
          ? "a" + ch
          : cluster(ch + "a").length === 1
            ? ch + "a"
            : null;
      if (joins === null) continue;
      let cells = 0;
      forEachCell(joins, () => {
        cells += 1;
      });
      if (cells !== 1) misses.push(`U+${codePoint.toString(16).toUpperCase()}: ${cells} cells`);
    }
    expect(misses).toEqual([]);
  });

  it("the cluster gate catches the astral joiner tail (regression)", () => {
    // The full astral tail, derived by the exhaustive Intl.Segmenter probe
    // (`pnpm run check:risky-tail`, same derivation as the BMP sweep
    // above) and pinned here as ranges: prepend-joins the following base,
    // or self-pair joins (Hangul jamo L×L/V×V/T×T — including the
    // Extended-A/B blocks a hand-written range misses — and Kirat Rai).
    // Each listed code point must walk as ONE cell with its partner; the
    // fast tier would visit two (and a wrap could break between them).
    const prependRanges: Array<[number, number]> = [
      [0x111c2, 0x111c3],
      [0x113d1, 0x113d1],
      [0x1193f, 0x1193f],
      [0x11941, 0x11941],
      [0x11a84, 0x11a89],
      [0x11d46, 0x11d46],
      [0x11f02, 0x11f02],
    ];
    const selfPairRanges: Array<[number, number]> = [
      ...prependRanges,
      [0xa960, 0xa97c], // Hangul jamo extended-A (L×L)
      [0xd7b0, 0xd7c6], // jamo extended-B (V×V)
      [0xd7cb, 0xd7fb], // jamo extended-B (T×T)
      [0x16d63, 0x16d63], // Kirat Rai left power line (prepend)
      [0x16d67, 0x16d6a], // Kirat Rai vowels (V×V)
    ];
    expect(clusterProbe(prependRanges, (ch) => ch + "a")).toEqual([]);
    // Self-pairs, the probe shape that catches the jamo classes: L×L, V×V
    // and T×T all join, and each class only joins its own kind.
    expect(clusterProbe(selfPairRanges, (ch) => ch + ch)).toEqual([]);
  });

  it("wraps on cluster boundaries, never splitting one", () => {
    const rows = wrapAnsi("\u{1f1fa}\u{1f1f8}\u{1f1ef}\u{1f1f5}", {
      width: 2,
      maxRows: 3,
      fillBg: "",
      scheme: FALLBACK_THEME,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => measurePlain(row) === 2)).toBe(true);
    // Each row carries ONE whole flag: padding is zero because the flag
    // fills the row exactly (a split flag would leave 2 stray code units).
    expect(plain(rows[0]!)).toBe("\u{1f1fa}\u{1f1f8}");
    expect(plain(rows[1]!)).toBe("\u{1f1ef}\u{1f1f5}");
  });

  it("truncates on a cluster boundary", () => {
    const flags = fitAnsi("\u{1f1fa}\u{1f1f8}\u{1f1ef}\u{1f1f5}", 3, SEQ_RESET, SEQ_DIM);
    expect(measurePlain(flags)).toBe(3);
    expect(plain(flags)).toBe("\u{1f1fa}\u{1f1f8}\u203a");
    // An 11-code-unit cluster survives whole (its width is 2, not 11).
    const family = fitAnsi(
      "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
      5,
      SEQ_RESET,
      SEQ_DIM,
    );
    expect(measurePlain(family)).toBe(5);
    expect(plain(family)).toBe("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}   ");
  });
});
