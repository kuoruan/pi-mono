/**
 * The grammar-state seed lifecycle for embedded-syntax languages (vue's
 * `<script>`, html's `<style>`): a diff hunk is a mid-file slice with no
 * tag in view, so tokenizing it from the grammar's top level leaves the
 * embedded part scope-less — the "vue partial diff renders uncolored" bug.
 * The seed is the file text BEFORE the slice; tokenizing it once captures
 * the TextMate stack (which embedding we are inside), and the slice
 * tokenizes from that state.
 *
 * One module owns the whole lifecycle — the language gate, the slice rule
 * ("cover the diff's LAST hunk", view/width independent), the character
 * cap, the state cache, and the two producers (edit reads the post-edit
 * file from disk, write has it in args). Producers supply only where the
 * file text lives; consumers receive a capped seed or undefined.
 */

import type { GrammarState, HighlighterCore } from "shiki";

import { createBoundedMap } from "#src/core/bounded-map.ts";
import type { ParsedDiff } from "#src/core/diff.ts";
import { fnv1a } from "#src/core/fingerprint.ts";
import { linesBefore, textBeforeLine } from "#src/core/lines.ts";

import type { BundledLanguage } from "./shiki-core.ts";

/**
 * The grammars that EMBED another syntax: vue's `<script>`, html's
 * `<style>`, php's inline mode, a markdown fence. A mid-file hunk of such
 * a language carries no tag in view, so a from-the-top tokenize renders
 * the embedded part flat — the one case where a grammar seed changes the
 * render. Everywhere else the seed would tokenize the same input to the
 * same tokens, so the price (a disk read and a prefix-sized tokenize) is
 * paid for nothing.
 */
const SEED_LANGUAGES: ReadonlySet<string> = new Set([
  "angular-html",
  "astro",
  "blade",
  "erb",
  "haml",
  "handlebars",
  "hbs",
  "html",
  "jade",
  "jinja",
  "liquid",
  "markdown",
  "md",
  "mdx",
  "php",
  "pug",
  "razor",
  "svelte",
  "twig",
  "vue",
]);

/**
 * Whether a language embeds another syntax — the gate for the edit
 * preview's disk-backed grammar seed (see {@link SEED_LANGUAGES}).
 *
 * @param language - The detected language, if any.
 * @returns True when a seed can change the render.
 */
export function needsSeed(language: BundledLanguage | undefined): boolean {
  return language !== undefined && SEED_LANGUAGES.has(language);
}

/**
 * The seed prefix's character cap. The seed rides into the tokenizer as
 * `grammarContextCode`, so the prefix is paid for twice — once slicing it
 * out of the file, once (the dominant term) in the tokenize that consumes
 * it: measured ~2-3 ms per KB (10KB ≈ 30ms, 86KB ≈ 170ms on a cold
 * cache). Past this cap the unseeded render is the better trade — the
 * embedded region degrades to flat, the frame stays responsive.
 */
export const MAX_SEED_CHARS = 64 * 1024;

/**
 * Where a seed's file text lives: given the slice point (a new-file line
 * number), return the file text BEFORE it, or undefined when unavailable.
 * Edit reads the post-edit file from disk (memoized per call); write has
 * it in args. Returning undefined renders unseeded (the pre-fix behavior —
 * embedded grammars color from the top level).
 */
export type SeedSource = (hunkNewStart: number) => string | undefined;

/**
 * A seed source over already-held text (the write wrapper's args.content).
 *
 * @param text - The full new-file text.
 * @param language - The detected language (the seed gate).
 * @returns The source, or undefined when the language needs no seed.
 */
export function seedFromText(
  text: string,
  language: BundledLanguage | undefined,
): SeedSource | undefined {
  if (!needsSeed(language)) return undefined;
  return (start: number): string | undefined => capSeed(textBeforeLine(text, start));
}

/**
 * A seed source over a lazily-read line array (the edit wrapper's
 * disk read, memoized across frames of one call).
 *
 * @param getLines - The line supplier (null = unreadable file).
 * @param language - The detected language (the seed gate).
 * @returns The source, or undefined when the language needs no seed.
 */
export function seedFromLines(
  getLines: () => readonly string[] | null,
  language: BundledLanguage | undefined,
): SeedSource | undefined {
  if (!needsSeed(language)) return undefined;
  return (start: number): string | undefined => {
    const lines = getLines();
    return lines ? capSeed(linesBefore(lines, start)) : undefined;
  };
}

/**
 * Enforce the character cap at the source (the consumer keeps its own
 * check — defense in depth, not a contract).
 *
 * @param seed - The sliced prefix, if any.
 * @returns The seed when within cap, else undefined.
 */
function capSeed(seed: string | undefined): string | undefined {
  return seed !== undefined && seed.length <= MAX_SEED_CHARS ? seed : undefined;
}

/**
 * The diff's LAST hunk start (new-file numbering): the seed covers the
 * diff outright, so the slice point is view/width independent — a resize
 * re-render reuses the same seed (and its cached grammar state).
 *
 * @param diff - The parsed diff.
 * @returns The deepest hunk's new-file start line, or 1 when the
 *   diff carries no hunk headers (the programmatic parseDiff path).
 */
export function lastHunkNewStart(diff: ParsedDiff): number {
  // Parser invariant this leans on: both producers (parseDiff,
  // parsePatchFiles) open non-empty diffs with sep lines carrying
  // hunkMeta. Track the LAST sep line's start over ALL lines — view and
  // width independent by construction.
  // the newNum fallback and the terminal 1 exist for that contract, not
  // for this caller's call sites.
  let last = 0;
  for (const line of diff.lines) {
    if (line.hunkMeta?.newStart) last = line.hunkMeta.newStart;
    else if (last === 0 && line.newNum !== null) last = line.newNum;
  }
  return last >= 1 ? last : 1;
}

/**
 * Seed grammar states, shared across a diff's hunk blocks: one seed's
 * `getLastGrammarState` tokenize (~2-3ms/KB) serves every block carrying
 * it, instead of each block re-tokenizing the seed as `grammarContextCode`
 * (the N× cost a multi-hunk diff's settle frame pays). Keyed by language +
 * theme + seed hash: GrammarState binds stacks per theme and cross-theme
 * use throws. Small next to the highlight cache: one entry per distinct
 * seed, not per block.
 */
const grammarStateCache = createBoundedMap<string, GrammarState>(16);

/**
 * The seed's end grammar state under a registered theme name (the shared
 * per-seed+theme computation; the state never reaches the output, only
 * the slice tokenizes from it).
 *
 * @param core - The shiki core.
 * @param seed - The capped seed text.
 * @param language - The block's language.
 * @param registeredThemeName - The theme's registered name (IN the key:
 *   GrammarState binds its stacks per theme and codeToTokensBase THROWS
 *   on a cross-theme state).
 * @returns The cached-or-computed grammar state.
 */
export function seedGrammarState(
  core: HighlighterCore,
  seed: string,
  language: string,
  registeredThemeName: string,
): GrammarState {
  const stateKey = [language, registeredThemeName, fnv1a(seed)].join("\0");
  const hit = grammarStateCache.get(stateKey);
  if (hit) return hit;
  const state = core.getLastGrammarState(seed, { lang: language, theme: registeredThemeName });
  grammarStateCache.set(stateKey, state);
  return state;
}

/**
 * Drop every cached seed grammar state (test seam — joins the suite's
 * aggregate highlight reset).
 */
export function clearSeedCacheForTest(): void {
  grammarStateCache.clear();
}
