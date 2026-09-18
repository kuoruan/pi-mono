/**
 * The Shiki engine adapter: the lazy highlighter-core singleton (shared by
 * every highlight path) and the forced-truecolor token→ANSI renderer. The
 * token renderer closes each colored token's fg with ESC[39m — no full
 * resets — so callers compose colors over a base or inject backgrounds.
 */

import {
  createHighlighterCore,
  createOnigurumaEngine,
  guessEmbeddedLanguages,
  type HighlighterCore,
  type LanguageInput,
  type ThemedToken,
} from "shiki";

import { fgRgb } from "#src/core/ansi.ts";
import { createBoundedMap } from "#src/core/bounded-map.ts";
import { parseHexColor } from "#src/core/color.ts";
import {
  SEQ_BOLD,
  SEQ_BOLD_OFF,
  SEQ_FG_DEFAULT,
  SEQ_ITALIC,
  SEQ_ITALIC_OFF,
  SEQ_STRIKE,
  SEQ_STRIKE_OFF,
  SEQ_UNDERLINE,
  SEQ_UNDERLINE_OFF,
} from "#src/core/escapes.ts";

/**
 * A Shiki language id or registered alias (e.g. "typescript", "ts").
 *
 * `string & {}` (not shiki's strict literal union):
 * detectLanguage's output mixes the SDK's extension map with the runtime
 * registry keys (bundledLanguages + aliases), either of which can drift
 * from shiki's static union — ensureCore's language-load-failure fallback
 * exists for exactly that. The loose form keeps literal autocomplete
 * while accepting a drifted id as a plain string. Lives HERE (next to
 * the engine that validates it) so the adapter never back-imports the
 * highlight module — the dependency stays one-directional.
 */
export type BundledLanguage = string & {};

/**
 * Italic bit of Shiki's FontStyle (vscode-textmate: Italic=1, Bold=2, Underline=4,
 * Strikethrough=8).
 */
const FONT_ITALIC = 1;
/** Bold bit of Shiki's FontStyle. */
const FONT_BOLD = 2;
/** Underline bit of Shiki's FontStyle. */
const FONT_UNDERLINE = 4;
/** Strikethrough bit of Shiki's FontStyle. */
const FONT_STRIKETHROUGH = 8;

/** The shared highlighter core (lazy; the Oniguruma WASM engine is a process singleton). */
let corePromise: Promise<HighlighterCore> | undefined;

/**
 * Ensure the core exists and the language is loaded (shared with highlight.ts).
 *
 * The Oniguruma WASM engine is shiki's Node default and the canonical
 * TextMate reference (VS Code/vscode-textmate's engine): on realistic
 * dense sources it tokenizes 3-6x faster than the JavaScript-regex engine
 * (which pays oniguruma-to-es regex transpilation + lazy per-pattern
 * compilation at first use), and it has no lazy-compile machinery to
 * flirt with — the grammar-state flake's root-cause carrier.
 * Creation pays a one-time ~40ms WASM instantiation, absorbed by the
 * async plain-then-styled upgrade every highlight consumer renders
 * through. See tests/theme/shiki-engine.bench.ts (BENCH_ENGINE=onig) for
 * the pinned measurements.
 *
 * @param language - The language to load.
 * @param probe - The text being highlighted (code plus its grammar seed):
 *   shiki's guessEmbeddedLanguages scans it for embedded-language markers
 *   (`lang="tsx"`, fences) and loads only those companions.
 * @returns The highlighter core, or undefined when the language cannot load.
 */
export async function ensureCore(
  language: BundledLanguage,
  probe = "",
): Promise<HighlighterCore | undefined> {
  try {
    // The await sits INSIDE this try: a construction rejection must reach
    // this catch to clear the poisoned memo.
    corePromise ??= createHighlighterCore({
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
    const resolved = await corePromise;
    try {
      const loaded = new Set(resolved.getLoadedLanguages());
      // Embedded blocks (shiki#791 made them lazy by design): a host like vue
      // declares only the ts/js/css/html closure, so `<script lang="tsx">`
      // includes `source.tsx` that never loads — the block falls back to the
      // host's flat foreground (the "vue tsx diff renders uncolored" report).
      // Guess from the ACTUAL text (shiki's own guessEmbeddedLanguages, the
      // same one createSingletonShorthands uses): only grammars the content
      // references get loaded, and only once. The seed rides along — a hunk
      // slice shows no `<script>` tag, so the seed is where the lang
      // attribute lives.
      const wanted = [
        ...(loaded.has(language) ? [] : [language]),
        ...guessEmbeddedLanguages(probe, language).filter(
          (lang) => lang !== language && !loaded.has(lang),
        ),
      ];
      if (wanted.length > 0) {
        await loadWithHostFallback(resolved, language, wanted, loaded);
      }
      return resolved;
    } catch {
      // The LANGUAGE failed to load (unknown id, broken grammar module) —
      // the core itself is fine. Keep it (other languages keep their
      // loaded grammars) and let this caller fall back to plain text.
      // Deterministic failures aren't memoized: the retry cost is one
      // failed import, paid by the rare broken-language caller only.
      return undefined;
    }
  } catch {
    // A rejected construction poisons the cached promise — clear it so the
    // next highlight retries instead of failing forever.
    corePromise = undefined;
    return undefined;
  }
}

/**
 * Load language modules into the core in ONE batch: the dynamic imports run
 * in parallel and core.loadLanguage takes all registrations at once (its own
 * Promise.all — the same single call createSingletonShorthands makes).
 *
 * @param core - The highlighter core.
 * @param languages - The shiki language modules to load.
 */
async function loadLanguageModules(
  core: HighlighterCore,
  languages: readonly string[],
): Promise<void> {
  const mods = await Promise.all(
    languages.map(async (language) => {
      const mod = (await import(`shiki/dist/langs/${language}.mjs`)) as {
        /** The language grammar module's default export. */
        default: LanguageInput;
      };
      return mod.default;
    }),
  );
  await core.loadLanguage(...mods);
}

/**
 * Load one batch of languages with a host-alone retry: a single missing
 * module rejects the whole batch, so on failure the host retries ALONE (a
 * missing tsx must not uncolor a ts-only file); only the host failing twice
 * throws — the caller then falls through to plain text.
 *
 * @param core - The highlighter core.
 * @param host - The MUST-load host language.
 * @param wanted - The full batch (host first, then embedded companions).
 * @param loaded - The languages already loaded (host retry skips when set).
 */
async function loadWithHostFallback(
  core: HighlighterCore,
  host: string,
  wanted: readonly string[],
  loaded: ReadonlySet<string>,
): Promise<void> {
  try {
    await loadLanguageModules(core, wanted);
  } catch {
    if (!loaded.has(host)) await loadLanguageModules(core, [host]);
  }
}

/**
 * The token open+close escape pair for one color+fontStyle combination —
 * everything in the rendered token EXCEPT the content text.
 */
interface TokenWrapping {
  /** The style-open + fg-color escape prefix. */
  open: string;
  /** The fg-default + style-close escape suffix. */
  close: string;
}

/**
 * The token wrapping cache: one entry per distinct color+fontStyle pair
 * (dozens per theme) instead of one hex parse + string build per token
 * (thousands per diff). The hex strings ARE the theme's colors, so a theme
 * switch keys itself — no invalidation needed. Bounded by the shared
 * two-generation memo (same policy as the highlight caches).
 */
const wrappingCache = createBoundedMap<string, TokenWrapping>(512);

/**
 * The open+close escapes for one token's color+fontStyle (the cache's
 * miss path: one hex parse, then freeze the pair).
 *
 * @param color - The token's hex color.
 * @param fontStyle - The token's fontStyle bitmask.
 * @returns The wrapping escape pair.
 */
function tokenWrapping(color: string, fontStyle: number): TokenWrapping {
  const key = `${color}\0${fontStyle}`;
  const hit = wrappingCache.get(key);
  if (hit) return hit;
  const { r, g, b } = parseHexColor(color) ?? { r: 188, g: 188, b: 188 };
  const style = fontStyleOpen(fontStyle);
  const close = style
    ? `${SEQ_BOLD_OFF}${SEQ_ITALIC_OFF}${SEQ_UNDERLINE_OFF}${SEQ_STRIKE_OFF}`
    : "";
  const wrapping: TokenWrapping = {
    open: `${style}${fgRgb({ r, g, b })}`,
    close: `${SEQ_FG_DEFAULT}${close}`,
  };
  wrappingCache.set(key, wrapping);
  return wrapping;
}

/**
 * Convert one codeToTokensBase result to an ANSI string: hex→escape,
 * fontStyle-bit wrapping, through our forced-truecolor contract (never an
 * ambient color instance — NO_COLOR/FORCE_COLOR must not reach us).
 *
 * The ESC[39m close (no full reset) is a contract: shell-tool.ts composes
 * its base color AFTER each close by string replacement — and because
 * hlBlock caches the rendered text, the composition must stay downstream
 * of the cache (composing here would key the cache on a base it doesn't
 * know about). Don't "simplify" the close sequence.
 *
 * @param tokens - The token lines from codeToTokensBase.
 * @returns The ANSI-rendered text.
 */
export function renderTokenLinesAnsi(tokens: ThemedToken[][]): string[] {
  return tokens.map((line) =>
    line
      .map((token) => {
        if (!token.color) return token.content;
        const { open, close } = tokenWrapping(token.color, token.fontStyle ?? 0);
        return `${open}${token.content}${close}`;
      })
      .join(""),
  );
}

/**
 * The opening escape for a Shiki fontStyle bitmask (bit-tested, matching
 * vscode-textmate: Italic=1, Bold=2, Underline=4, Strikethrough=8).
 *
 * @param fontStyle - The style bitmask.
 * @returns The combined opening escape ("" when unstyled).
 */
function fontStyleOpen(fontStyle: number): string {
  let open = "";
  if (fontStyle & FONT_ITALIC) open += SEQ_ITALIC;
  if (fontStyle & FONT_BOLD) open += SEQ_BOLD;
  if (fontStyle & FONT_UNDERLINE) open += SEQ_UNDERLINE;
  if (fontStyle & FONT_STRIKETHROUGH) open += SEQ_STRIKE;
  return open;
}
