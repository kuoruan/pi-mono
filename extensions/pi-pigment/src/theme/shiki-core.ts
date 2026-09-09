/**
 * The Shiki engine adapter: the lazy highlighter-core singleton (shared by
 * every highlight path) and the forced-truecolor token→ANSI renderer. The
 * token renderer closes each colored token's fg with ESC[39m — no full
 * resets — so callers compose colors over a base or inject backgrounds.
 */

import {
  createHighlighterCore,
  createJavaScriptRegexEngine,
  type HighlighterCore,
  type ThemedToken,
} from "shiki";

import { fgRgb } from "#src/core/ansi.ts";
import { parseHexColor } from "#src/core/color.ts";

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

/** The shared highlighter core (lazy; grammar engine is a process singleton). */
let corePromise: Promise<HighlighterCore> | undefined;

/**
 * Ensure the core exists and the language is loaded (shared with highlight.ts).
 *
 * @param language - The language to load.
 * @returns The highlighter core, or undefined when the language cannot load.
 */
export async function ensureCore(language: BundledLanguage): Promise<HighlighterCore | undefined> {
  try {
    // The await sits INSIDE this try: a construction rejection must reach
    // this catch to clear the poisoned memo.
    corePromise ??= createHighlighterCore({ engine: createJavaScriptRegexEngine() });
    const resolved = await corePromise;
    try {
      if (!resolved.getLoadedLanguages().includes(language)) {
        const mod = (await import(`shiki/dist/langs/${language}.mjs`)) as {
          /** The language grammar module's default export. */
          default: unknown;
        };
        await resolved.loadLanguage(mod.default as never);
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
        const { r, g, b } = parseHexColor(token.color) ?? { r: 188, g: 188, b: 188 };
        const style = fontStyleOpen(token.fontStyle ?? 0);
        const close = style ? `\x1b[22m\x1b[23m\x1b[24m\x1b[29m` : "";
        return `${style}${fgRgb({ r, g, b })}${token.content}\x1b[39m${close}`;
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
  if (fontStyle & FONT_ITALIC) open += "\x1b[3m";
  if (fontStyle & FONT_BOLD) open += "\x1b[1m";
  if (fontStyle & FONT_UNDERLINE) open += "\x1b[4m";
  if (fontStyle & FONT_STRIKETHROUGH) open += "\x1b[9m";
  return open;
}
