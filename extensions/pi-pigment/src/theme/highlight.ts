/**
 * Shiki syntax highlighting — the highlight LRU cache, language detection,
 * and the hlBlock entry (ADR 0001/0002). Render-time theme interpretation
 * lives in theme-selection.ts.
 */

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { bundledLanguages, bundledLanguagesAlias } from "shiki";

import { createBoundedMap } from "#src/core/bounded-map.ts";
import { fnv1a } from "#src/core/fingerprint.ts";
import { linesOf } from "#src/core/lines.ts";

import { loadBundledTheme } from "./bundled-intake.ts";
import type { DiffPalette, PaletteTheme } from "./palette.ts";
import { ensureCore, renderTokenLinesAnsi, type BundledLanguage } from "./shiki-core.ts";
import type { ShikiThemeInput } from "./syntax-theme.ts";
import { resolveActiveTheme } from "./theme-selection.ts";

/** Skip highlighting above this size — the diff still renders, unstyled. */
export const MAX_HL_CHARS = 80_000;

/**
 * Themes the core has registered: theme name → the EXACT object it loaded.
 * Every block's render calls core.loadTheme(themeObject), which
 * re-normalizes the input each time; when the same object is already
 * registered under its name, the call is skipped. A DIFFERENT object
 * under the same name (enforced variants rebuild per palette identity)
 * still re-registers — same name ≠ same colors.
 */
const registeredThemeObjects = createBoundedMap<string, object>(64);

/**
 * LRU capacity for highlighted blocks. Entry-count bound, not a byte
 * budget: MAX_HL_CHARS caps each entry (~80 KB raw, ~2–3× with escapes),
 * so the worst-case residency is ~192 × 240 KB ≈ 45 MB and realistic
 * sessions sit far below — byte-budget eviction would add bookkeeping
 * the observed footprint does not justify.
 */
const CACHE_LIMIT = 192;

/**
 * The language keys Shiki's bundle accepts: language ids plus registered
 * aliases — which the community keeps populated with file extensions
 * ("ts", "py", "zig", "nu", …). This set IS the extension map: a file's
 * extension (lowercased) that hits the set is a valid `lang` argument as-is,
 * covering 300+ languages without a hand-maintained table. Extensionless
 * convention files match too ("Makefile" → "makefile").
 */
const LANGUAGE_KEYS: ReadonlySet<string> = new Set(
  [...Object.keys(bundledLanguages), ...Object.keys(bundledLanguagesAlias)].map((key) =>
    key.toLowerCase(),
  ),
);

/** The few header extensions neither the SDK's map nor Shiki's keys carry. */
const EXTRA_EXT_LANG: Record<string, BundledLanguage> = {
  hxx: "cpp",
  hh: "cpp",
};

/**
 * Detect the Shiki language for a file path: the SDK's own extension map
 * first (the authority — it knows the C-header and makefile spellings),
 * then Shiki's language keys (ids + alias registry, which the community
 * keeps populated with newer extensions), then the two header spellings
 * neither carries.
 *
 * @param filePath - The file path to inspect.
 * @returns The Shiki language id, or undefined when unknown.
 */
export function detectLanguage(filePath: string): BundledLanguage | undefined {
  const sdk = getLanguageFromPath(filePath);
  if (sdk) return sdk as BundledLanguage;
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = (dot === -1 ? name : name.slice(dot + 1)).toLowerCase();
  if (!ext) return undefined;
  if (LANGUAGE_KEYS.has(ext)) return ext as BundledLanguage;
  return EXTRA_EXT_LANG[ext];
}

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

// ---------------------------------------------------------------------------
// The highlight cache
// ---------------------------------------------------------------------------
// No engine prewarm (measured: the shiki module's
// ~28ms import is paid at extension load (this file's static registry
// import), leaving ensureCore ~45ms (WASM instantiate ~40 + grammar 3)
// — and every hlBlock consumer renders through an async plain-then-
// styled upgrade (text-task / invalidate) that makes any load latency
// invisible. There is no regex compilation to warm: the Oniguruma WASM
// engine interprets TextMate patterns directly (the JavaScript-regex
// engine's lazy per-pattern compile premium — ~600ms on the first
// tokenize of a 29KB file — left with that engine). Shiki's own guidance
// is the lazy singleton (ensureCore's promise memo); VS Code renders
// plain and restyles when the tokenizer catches up — the same model.
const highlightCache = createBoundedMap<string, string[]>(CACHE_LIMIT);

/**
 * Drop every cached highlight (test seam — the suite's aggregate reset).
 * The cache itself is correct-by-construction (deterministic tokenize of
 * deterministic keys); the seam exists so a test can force a re-render
 * through a fresh derivation after resetting the theme-selection state.
 * (NOT for corePromise — that singleton is where an engine-level
 * corruption would persist; its only isolation boundary is the process.
 * See docs/open-issues/grammar-state-flake.md.)
 */
export function clearHighlightCacheForTest(): void {
  highlightCache.clear();
}

/** The hlBlock inputs. */
export interface HlBlockOptions {
  /** The code block. */
  code: string;
  /** The Shiki language (undefined skips highlighting). */
  language: BundledLanguage | undefined;
  /** The resolved palette (drives theme enforcement). */
  palette: DiffPalette;
  /** The pi theme (the auto theme's color source). */
  piTheme?: PaletteTheme;
  /** Optional pre-slice file text (grammar-state seeding). */
  seed?: string;
}

/**
 * Highlight a code block with Shiki → ANSI lines (memoized, per the
 * resolved theme's tokens over the palette-enforced colors). Falls back
 * to unhighlighted lines when the language is unknown, the block is too
 * large, or Shiki fails.
 *
 * The optional seed is grammar-state seeding for embedded grammars (vue,
 * html): a diff hunk is a mid-file slice with no `<script>`/`<template>`
 * tag in view, so tokenizing it from the grammar's top level leaves script
 * lines scope-less — the "vue partial diff renders uncolored" bug. The
 * seed is the file text BEFORE the slice; tokenizing it once captures the
 * TextMate stack (which embedding we are inside), and the slice
 * tokenizes from that state. A seed past {@link MAX_SEED_CHARS} is
 * dropped (see the cap's note) — the block then renders unseeded.
 *
 * @param options - The block's inputs.
 * @returns The highlighted (or fallback) lines.
 */
export async function hlBlock(options: HlBlockOptions): Promise<string[]> {
  const { code, language, palette, piTheme } = options;
  if (!code) return [""];
  if (!language || code.length > MAX_HL_CHARS) return linesOf(code);
  const theme = await resolveActiveTheme(palette, piTheme);
  if (!theme) return linesOf(code); // unresolvable selection: unstyled
  // An oversized prefix is dropped HERE, at the one point that pays for
  // it: the seed rides into `grammarContextCode`, so producers hand over
  // whatever they have and the cap is enforced where the tokenize happens.
  const seed =
    options.seed !== undefined && options.seed.length <= MAX_SEED_CHARS ? options.seed : undefined;
  const themeId =
    typeof theme === "string"
      ? theme
      : theme.contentFingerprint
        ? `${theme.name}~${theme.contentFingerprint}`
        : theme.name;
  const seedKey = seed ? fnv1a(seed) : "";
  const key = [themeId, language, seedKey, code].join("\0");
  // BoundedMap's get refreshes recency (the LRU touch).
  const cached = highlightCache.get(key);
  if (cached) return cached;
  try {
    // Render through our own token→ANSI path (forced truecolor): the
    // cli wrapper routes through ansis' AMBIENT instance, which collapses
    // under NO_COLOR — breaking the palette/syntax color contract.
    const output = await renderThemeToAnsi(code, language, theme, seed);
    // shiki emits one (empty) token line per trailing newline; the
    // block's line contract is `code`'s own lines — a trailing newline
    // does NOT add a trailing empty line (views join line arrays, so
    // this normalizes both to the array's shape).
    const trimmed = code.endsWith("\n") && output.length > 0 ? output.slice(0, -1) : output;
    highlightCache.set(key, trimmed);
    return trimmed;
  } catch {
    return linesOf(code);
  }
}

/**
 * Render code to ANSI through the shiki core with a theme input (bundled id
 * or object), tokenizing and applying our forced-truecolor renderer.
 *
 * @param code - The code to highlight.
 * @param language - The language.
 * @param themeInput - The theme input (id, object, or null).
 * @param seed - Optional pre-slice text (grammar-state seeding).
 * @returns One ANSI string per line.
 */
async function renderThemeToAnsi(
  code: string,
  language: BundledLanguage,
  themeInput: ShikiThemeInput | null,
  seed?: string,
): Promise<string[]> {
  if (!themeInput) return linesOf(code);
  const core = await ensureCore(language);
  if (!core) return linesOf(code);
  // Normalize to a registered theme: a bundled id materializes through
  // the intake (translucent flattening); an object registers AS-IS — its
  // identity lives on, so the per-block loadTheme skip (see
  // registeredThemeObjects) compares references.
  const themeObject =
    typeof themeInput === "string" ? await loadBundledTheme(themeInput) : themeInput;
  if (!themeObject) return linesOf(code);
  // Skip the per-block loadTheme when this exact object is already
  // registered under its name (see registeredThemeObjects).
  if (registeredThemeObjects.get(themeObject.name) !== themeObject) {
    await core.loadTheme(themeObject);
    registeredThemeObjects.set(themeObject.name, themeObject);
  }
  // Grammar-state seeding (embedded grammars) through shiki's own
  // `grammarContextCode`: the seed participates in grammar inference as
  // prepended code and never reaches the output.
  const tokens = await core.codeToTokensBase(code, {
    lang: language,
    theme: themeObject.name,
    grammarContextCode: seed,
  });
  return renderTokenLinesAnsi(tokens);
}
