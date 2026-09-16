/**
 * Risky-tail synchronizer for `RISKY_CODE_POINT_RE` in `src/core/ansi.ts`.
 *
 * The gate's class preamble (`\p{M}`, `\p{Cf}`, `\p{Cs}`,
 * `\p{Default_Ignorable_Code_Point}`, `\p{Emoji_Modifier}`) and block ranges
 * track the runtime's own Unicode tables, but they are PROXIES for the
 * UAX #29 property that actually matters: "this code point joins the
 * grapheme cluster of its neighbour". V8's regular expressions do not expose
 * `Prepend` or `SpacingMark` (they are segmentation rules, not binary
 * properties), so the code points outside the proxies have to be listed
 * explicitly — the "tail".
 *
 * This tool derives that tail from the only authority the renderer has:
 * `Intl.Segmenter`. For every code point it asks whether `"a" + cp`,
 * `cp + "a"` or `cp + cp` segments as ONE cluster. Anything the preamble
 * does not already cover and that still merges belongs in the tail; anything
 * that merges less is drift.
 *
 * The self-pair probe is what catches the Hangul jamo classes (L×L, V×V and
 * T×T all join), including the Extended-A/Extended-B blocks that a hand-
 * written range misses. The probes cannot see joins that need a *different*
 * partner class inside a larger sequence (Indic InCB consonant clusters),
 * but those sequences always carry a mark or format-code-point joiner, so
 * the preamble's `\p{M}`/`\p{Cf}` gates the line anyway.
 *
 * Usage:
 * node tools/sync-risky-tail.ts           # check (exit 1 when the tail drifted)
 * node tools/sync-risky-tail.ts --write   # regenerate the block in place
 *
 * `--write` emits oxfmt's own line breaking; if the format config changes,
 * run the repo's `fmt` script afterwards.
 *
 * Run this after a Node/ICU upgrade (the preamble follows the engine's
 * tables; a hard-coded tail cannot). Takes ~10s for all 1,114,112 code
 * points — it is deliberately NOT part of CI; `pnpm test`'s exhaustive BMP
 * gate-agreement sweep is the fast guard that runs on every commit.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `src/core/ansi.ts`, resolved from this file so cwd does not matter. */
const ANSI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/core/ansi.ts");

/** The class preamble of the gate — the proxy properties and block ranges. */
const PREAMBLE =
  "\\p{M}\\p{Cf}\\p{Cs}\\p{Default_Ignorable_Code_Point}\\p{Emoji_Modifier}" +
  "\\u{1100}-\\u{11ff}\\u{1f1e6}-\\u{1f1ff}";

const PREAMBLE_RE = new RegExp(`[${PREAMBLE}]`, "u");

/** Block markers around the generated statement. */
const BLOCK_START = "// sync-risky-tail:begin";
const BLOCK_END = "// sync-risky-tail:end";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Whether `text` segments as a single grapheme cluster.
 *
 * @param text - The probe string.
 * @returns True when the segmenter yields exactly one cluster.
 */
function isOneCluster(text: string): boolean {
  let count = 0;
  for (const _ of segmenter.segment(text)) {
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

/**
 * Whether a code point joins its neighbour's cluster in any probed context:
 * as an extension of what precedes it, as a prepend of what follows it, or
 * in a pair of its own kind (regional indicators form flags with a peer).
 *
 * @param cp - The code point to probe.
 * @returns True when the code point is cluster-forming.
 */
function isRisky(cp: number): boolean {
  const ch = String.fromCodePoint(cp);
  if (PREAMBLE_RE.test(ch)) return true; // already gated by a proxy class
  return isOneCluster(`a${ch}`) || isOneCluster(`${ch}a`) || isOneCluster(ch + ch);
}

/**
 * Render the tail's code points as a compact regex body: consecutive code
 * points collapse into `\u{start}-\u{end}` ranges.
 *
 * @param codePoints - Sorted, de-duplicated risky code points.
 * @returns The tail's regex source.
 */
function formatTail(codePoints: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < codePoints.length) {
    const start = codePoints[i];
    let end = start;
    while (i + 1 < codePoints.length && codePoints[i + 1] === end + 1) {
      i += 1;
      end = codePoints[i];
    }
    const from = `\\u{${start.toString(16)}}`;
    parts.push(start === end ? from : `${from}-\\u{${end.toString(16)}}`);
    i += 1;
  }
  return parts.join("");
}

/**
 * The generated statement, markers included.
 *
 * @param tail - The formatted tail body ("" when the preamble covers everything).
 * @returns The block text to splice into `ansi.ts`.
 */
function renderBlock(tail: string): string {
  // `const X =` + indented literal: oxfmt's exact layout for a statement
  // this long, so --write output lands pre-formatted.
  return [BLOCK_START, "const RISKY_CODE_POINT_RE =", `  /[${PREAMBLE}${tail}]/u;`, BLOCK_END].join(
    "\n",
  );
}

/**
 * Extract the code points of the block currently in `ansi.ts` so the report
 * can name missing/extra entries instead of only "the block differs".
 *
 * @param block - The current block text.
 * @returns The sorted code points listed in its tail.
 */
function tailCodePoints(block: string): number[] {
  const literal = /\/\[([\s\S]*)\]\//.exec(block);
  if (literal === null) return [];
  const inner = PREAMBLE;
  const tailSource = literal[1].slice(inner.length);
  const codePoints: number[] = [];
  const item = /\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4}))(?:-\\u(?:\{([0-9a-f]+)\}|([0-9a-f]{4})))?/gi;
  for (const match of tailSource.matchAll(item)) {
    const start = Number.parseInt(match[1] ?? match[2], 16);
    const end = match[3] ?? match[4];
    const stop = end === undefined ? start : Number.parseInt(end, 16);
    for (let cp = start; cp <= stop; cp += 1) codePoints.push(cp);
  }
  return codePoints.toSorted((a, b) => a - b);
}

/**
 * Human-readable code point label.
 *
 * @param cp - The code point.
 * @returns Its `U+XXXX` form.
 */
function label(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Derive the risky set and compare it with the block in `ansi.ts`.
 *
 * @param write - True to rewrite the block, false to check only.
 * @returns The process exit code (1 when the block drifted).
 */
function main(write: boolean): number {
  const started = process.hrtime.bigint();
  const risky: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates never decode
    if (isRisky(cp)) risky.push(cp);
  }
  const tailSet = risky.filter((cp) => !PREAMBLE_RE.test(String.fromCodePoint(cp)));
  const expected = renderBlock(formatTail(tailSet));
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;

  const source = readFileSync(ANSI_PATH, "utf8");
  const blockRe = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`);
  const found = source.match(blockRe);
  if (found === null) {
    console.error(`FAIL: no ${BLOCK_START} … ${BLOCK_END} block in ${ANSI_PATH}`);
    return 1;
  }

  // Compare CODE POINT SETS, not block text: oxfmt reflows the statement's
  // line breaks, so byte equality would false-positive after every format
  // run. Text drift without set drift is a formatting concern, not a gate
  // hole — only a set difference means the regex and the derivation split.
  const haveSet = new Set(tailCodePoints(found[0]));
  const wantSet = new Set(tailSet);
  const missing = tailSet.filter((cp) => !haveSet.has(cp)).map(label);
  const extra = [...haveSet].filter((cp) => !wantSet.has(cp)).map(label);
  console.log(`swept 1,114,112 code points in ${elapsed.toFixed(1)}s`);
  console.log(`cluster-forming (including preamble): ${risky.length}`);
  console.log(`tail entries (not covered by the preamble): ${tailSet.length}`);
  console.log(`tail: ${formatTail(tailSet) || "(preamble covers everything)"}`);

  if (missing.length === 0 && extra.length === 0) {
    console.log("status: IN SYNC");
    if (found[0] !== expected) {
      console.log("note: text differs from the generated form (formatting drift only)");
    }
    return 0;
  }

  console.log("status: DRIFT");
  if (missing.length > 0) console.log(`  regex MISSES (unsafe): ${missing.join(" ")}`);
  if (extra.length > 0) console.log(`  regex EXTRAS (safe, but stale): ${extra.join(" ")}`);

  if (write) {
    const rewritten = source.replace(blockRe, expected);
    if (rewritten === source) {
      console.error("FAIL: --write produced no change despite drift");
      return 1;
    }
    writeFileSync(ANSI_PATH, rewritten);
    console.log(`status: WROTE ${ANSI_PATH}`);
    return 0;
  }
  console.log(`run with --write to update; or edit ${ANSI_PATH} by hand`);
  return 1;
}

process.exitCode = main(process.argv.includes("--write"));
