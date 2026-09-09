/**
 * The bundled-theme intake: ONE loading path for every Shiki-bundled
 * theme, shared by all its consumers — direct-name selection and the
 * theme-file channel's virtual bundled file (session time), the
 * render-time bundled-name enforcement, and the generation script. Themes load
 * lazily by name (subpath exports of @shikijs/themes), imported once per
 * process (the module cache — concurrent loads share the promise);
 * materialization (name normalization, polarity check, translucent
 * flattening) is idempotent and its product is memoized per name — the
 * ONE materialized object every consumer shares. Nothing here touches the
 * palette, the roots, or pi — intake only.
 */
import { themeNames } from "@shikijs/themes";
import type { ThemeRegistration } from "shiki";

import { compositeHexOver, isAlphaHex8, parseOpaqueHex, rgbToHex } from "#src/core/color.ts";

import type { MaterializedTheme } from "./syntax-theme.ts";

/** Shiki's bundled theme names (a static array — validation needs no loading). */
const BUNDLED_THEME_NAMES: ReadonlySet<string> = new Set(themeNames);

/**
 * Promise cache: theme name → the materialized theme. The ONE seam —
 * Node's loader caches the module itself; this memo dedupes the whole
 * pipeline (import → validate → flatten), so concurrent and repeated
 * loads share one pending promise and every consumer gets the same
 * materialized object identity.
 */
const bundledThemes = new Map<string, MaterializedTheme | undefined>();

/**
 * Whether a name is one of Shiki's bundled themes.
 *
 * @param name - The candidate name.
 * @returns True when the name resolves to a bundled theme.
 */
export function isBundledThemeName(name: string): boolean {
  return BUNDLED_THEME_NAMES.has(name);
}

/**
 * The materialization pipeline (import → validate → flatten) — the
 * async body behind the promise memo; an eager call starts the import
 * immediately, so the memoized promise inlines the in-flight work.
 *
 * @param name - The bundled theme name.
 * @returns The materialized theme, or undefined when the load fails.
 */
async function materializeBundledTheme(name: string): Promise<MaterializedTheme | undefined> {
  try {
    // @vite-ignore: the template-literal subpath defeats vite's static
    // export analysis (vitest); jiti and node resolve it natively at
    // runtime against the package's per-theme export entries.
    const loaded = await import(/* @vite-ignore */ `@shikijs/themes/${name}`);

    const theme: ThemeRegistration | undefined = loaded.default ?? loaded;
    // The materialized form requires the polarity — every real bundled
    // theme carries it, but the registration type is optional, so the
    // boundary checks (and drops the unusable) rather than casting.
    if (!theme || typeof theme !== "object") return undefined;
    if (theme.type !== "light" && theme.type !== "dark") return undefined;
    return flattenTranslucentTokens({
      ...theme,
      name: theme.name || name,
      type: theme.type,
    } as MaterializedTheme); // spread widens; guard above proves name/type
  } catch {
    return undefined;
  }
}

/**
 * Load a Shiki-bundled theme by name: the ONE materialization home for
 * bundled themes — one promise memo per name covers the whole pipeline
 * (import → name normalization → polarity check → translucent flattening),
 * so concurrent and repeated loads share the load and every consumer
 * gets the same materialized object identity.
 *
 * @param name - The bundled theme name (validated by the caller, or the
 *   import rejects and settles undefined).
 * @returns The materialized theme, or undefined when the load fails.
 */
export async function loadBundledTheme(name: string): Promise<MaterializedTheme | undefined> {
  let pending = bundledThemes.get(name);
  if (!pending) {
    pending = await materializeBundledTheme(name);
    bundledThemes.set(name, pending);
  }
  return pending;
}

/**
 * Flatten a theme's translucent (8-digit `#rrggbbaa`) token colors onto
 * its own canvas — the materialization every theme intake applies
 * (bundled themes and user theme files alike): our ANSI renderer's
 * hex parser is 6-digit-only, and an unflattened 8-digit value would
 * fall to its gray fallback. Themes without a usable `editor.background`
 * pass through untouched (no known canvas to composite onto).
 *
 * @param theme - The theme object (not mutated).
 * @returns The theme with translucent token colors composited.
 */
export function flattenTranslucentTokens<T extends MaterializedTheme>(theme: T): T;
export function flattenTranslucentTokens<T extends ThemeRegistration>(theme: T): T;
export function flattenTranslucentTokens<T extends ThemeRegistration>(theme: T): T {
  const bgHex = theme.colors?.["editor.background"];
  // 3-digit shorthand expands (vitesse-black ships #000 as its canvas —
  // rejecting it would skip flattening and hand the renderer 8-digit
  // token colors it cannot parse).
  const base = bgHex ? parseOpaqueHex(bgHex) : null;
  if (!base) return theme; // no known canvas: leave the theme untouched
  let changed = false;
  const tokenColors = theme.tokenColors?.map((rule) => {
    // A rule may carry no `settings` at all (fontStyle-only or scope-
    // grouping rules — shiki's bundle ships a few); it has no foreground
    // to flatten.
    const fg = rule.settings?.foreground;
    if (!fg || !isAlphaHex8(fg)) return rule;
    const flat = compositeHexOver(fg, base);
    if (!flat) return rule;
    changed = true;
    return { ...rule, settings: { ...rule.settings, foreground: rgbToHex(flat) } };
  });
  if (!changed) return theme;
  return { ...theme, tokenColors };
}
