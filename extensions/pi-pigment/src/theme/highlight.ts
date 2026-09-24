/**
 * Shiki syntax highlighting — the highlight LRU cache, language detection,
 * and the highlight entries (`RenderView.highlight`, `hlBlockResolved`;
 * ADR 0001/0002). Render-time theme interpretation lives in
 * theme-selection.ts.
 */

import { createBoundedMap } from "#src/core/bounded-map.ts";
import { fnv1a } from "#src/core/fingerprint.ts";
import { linesOf } from "#src/core/lines.ts";

import { loadBundledTheme } from "./bundled-intake.ts";
import { MAX_SEED_CHARS, clearSeedCacheForTest, seedGrammarState } from "./seed.ts";
import { type BundledLanguage, ensureCore, renderTokenLinesAnsi } from "./shiki-core.ts";
import type { ShikiThemeInput } from "./syntax-theme.ts";

/** Skip highlighting above this size — the diff still renders, unstyled. */
export const MAX_HL_CHARS = 80_000;

/**
 * Themes the core has registered: registered theme name → the content
 * stamp it was loaded from — the theme object itself, or (file-channel
 * themes, which carry `contentFingerprint`) that fingerprint.
 *
 * Every block's render calls core.loadTheme(...); when the stamp for the
 * name is unchanged, the call is skipped. The fingerprint form matters
 * because shiki keys its registry by theme NAME and an already-created
 * grammar's color map does not follow a later same-name loadTheme:
 * without a content-distinct registered name, a same-stem file edited
 * between sessions (same name, new colors) would re-tokenize under the
 * OLD color map and cache the wrong bytes under the new cache key (see
 * renderThemeToAnsi).
 */
const registeredThemeObjects = createBoundedMap<string, object | string>(64);

/**
 * LRU capacity for highlighted blocks. Entry-count bound, not a byte
 * budget: MAX_HL_CHARS caps each entry (~80 KB raw, ~2–3× with escapes),
 * so the worst-case residency is ~192 × 240 KB ≈ 45 MB and realistic
 * sessions sit far below — byte-budget eviction would add bookkeeping
 * the observed footprint does not justify.
 */
const CACHE_LIMIT = 192;

// No engine prewarm (the shiki module's import is paid at extension load —
// this file's static registry import — leaving ensureCore the WASM
// instantiate plus grammar cost) — and every hlBlock consumer renders
// through an async plain-then-styled upgrade (text-task / invalidate) that
// makes any load latency invisible. There is no regex compilation to warm:
// the Oniguruma WASM engine interprets TextMate patterns directly (the
// JavaScript-regex engine's lazy per-pattern compile premium — paid once
// on the first tokenize of a real file — left with that engine). Shiki's
// own guidance is the lazy singleton (ensureCore's promise memo); VS Code
// renders plain and restyles when the tokenizer catches up — the same model.
const highlightCache = createBoundedMap<string, string[]>(CACHE_LIMIT);

/**
 * The cache itself is correct-by-construction (deterministic tokenize of
 * deterministic keys); the seam exists so a test can force a re-render
 * through a fresh derivation after resetting the theme-selection state.
 * (NOT for corePromise — that singleton is where an engine-level
 * corruption would persist; its only isolation boundary is the process.
 * See docs/open-issues/grammar-state-flake.md.)
 */
export function clearHighlightCacheForTest(): void {
  highlightCache.clear();
  clearSeedCacheForTest();
}

/**
 * A theme's content identity: a bundled id itself, an enforced/pi-derived
 * variant its own (already content-distinct) name, a file-channel theme
 * name~contentFingerprint — shiki keys its registry by theme NAME and a
 * created grammar's color map does not follow a later same-name loadTheme,
 * so two contents must never share a registered name. The highlight cache
 * keys on this same identity (see hlBlockResolved), so registration and
 * caching can never disagree.
 *
 * @param theme - The resolved theme input.
 * @returns The identity string.
 */
function themeIdentity(theme: ShikiThemeInput): string {
  return typeof theme === "string"
    ? theme
    : theme.contentFingerprint
      ? `${theme.name}~${theme.contentFingerprint}`
      : theme.name;
}

/**
 * The seam's highlight input (session.ts): the session binds the
 * theme; a block carries only its own content.
 */
export interface HighlightBlock {
  /** The code block. */
  code: string;
  /** The Shiki language (undefined skips highlighting). */
  language: BundledLanguage | undefined;
  /** Optional pre-slice file text (grammar-state seeding). */
  seed?: string;
}

/**
 * Highlight a code block with Shiki → ANSI lines (memoized, per the
 * resolved theme's tokens). Falls back to unhighlighted lines when the
 * language is unknown, the block is too large, or Shiki fails.
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
 * @param block - The block's own inputs.
 * @param theme - The resolved theme (null = unresolvable → unstyled).
 * @returns The highlighted (or fallback) lines.
 */
export async function hlBlockResolved(
  block: HighlightBlock,
  theme: ShikiThemeInput | null,
): Promise<string[]> {
  const { code, language } = block;
  if (!code) return [""];
  if (!language || code.length > MAX_HL_CHARS) return linesOf(code);
  if (!theme) return linesOf(code); // unresolvable selection: unstyled
  // An oversized prefix is dropped HERE, at the one point that pays for
  // it: the seed rides into `grammarContextCode`, so producers hand over
  // whatever they have and the cap is enforced where the tokenize happens.
  const seed =
    block.seed !== undefined && block.seed.length <= MAX_SEED_CHARS ? block.seed : undefined;
  const themeId = themeIdentity(theme);
  const seedKey = seed ? fnv1a(seed) : "";
  // The key carries hashes, not the sources: a worst-case 80KB face would
  // otherwise duplicate its text in every entry's key (192 entries x KBs =
  // MBs of key alone, plus a full-string compare per lookup). The length
  // prefixes the hash so same-length is the only collision surface — at a
  // 192-entry window a 32-bit collision there is ~2e-7 (and a miss merely
  // re-derives; a hit on a collided key would miscolor, hence the length).
  const key = [themeId, language, seedKey, code.length, fnv1a(code)].join("\0");
  const cached = highlightCache.get(key);
  if (cached) return cached;
  try {
    // Render through our own token→ANSI path (forced truecolor): the
    // cli wrapper routes through ansis' AMBIENT instance, which collapses
    // under NO_COLOR — breaking the scheme/syntax color contract.
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
  const core = await ensureCore(language, seed ? `${seed}\n${code}` : code);
  if (!core) return linesOf(code);
  // Normalize to a registered theme: a bundled id materializes through
  // the intake (translucent flattening); an object registers AS-IS — its
  // identity lives on, so the per-block loadTheme skip (see
  // registeredThemeObjects) compares references.
  const themeObject =
    typeof themeInput === "string" ? await loadBundledTheme(themeInput) : themeInput;
  if (!themeObject) return linesOf(code);
  // File-channel themes register under a CONTENT-DISTINCT name (the bare
  // stem would collide across contents — see themeIdentity).
  const registeredName = themeIdentity(themeObject);
  // Skip the per-block loadTheme when the content under this name is
  // unchanged (see registeredThemeObjects — the fingerprint is the stamp
  // for file-channel themes, the object itself otherwise).
  const stamp: object | string = themeObject.contentFingerprint ?? themeObject;
  if (registeredThemeObjects.get(registeredName) !== stamp) {
    await core.loadTheme(
      registeredName === themeObject.name ? themeObject : { ...themeObject, name: registeredName },
    );
    registeredThemeObjects.set(registeredName, stamp);
  }
  // Grammar-state seeding (embedded grammars — see seed.ts): the seed's end
  // state is computed ONCE per distinct seed+theme and shared by every block
  // carrying it — passing the state object skips the per-block seed
  // re-tokenize `grammarContextCode` would pay. The state never reaches
  // the output, only the slice tokenizes from it.
  const grammarState =
    seed !== undefined ? seedGrammarState(core, seed, language, registeredName) : undefined;
  const tokens = await core.codeToTokensBase(code, {
    lang: language,
    theme: registeredName,
    ...(grammarState ? { grammarState } : { grammarContextCode: seed }),
  });
  return renderTokenLinesAnsi(tokens);
}
