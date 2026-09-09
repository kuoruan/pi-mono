/**
 * The pi-derived syntax theme: a TextMate theme built from the active pi
 * theme's own nine `syntax*` colors (the colors pi itself uses for code),
 * WCAG-adjusted for the five diff backgrounds. This replaced a fixed
 * bundled palette as the "auto" behavior (ADR 0001): syntax colors now
 * adapt to the pi theme like the palette does, instead of borrowing a
 * fixed palette calibrated for someone else's editor background.
 *
 * Contrast enforcement: VS Code-calibrated syntax colors sit on our blended
 * diff backgrounds, and the word-emphasis backgrounds (bgAddedWord/bgRemovedWord) sit
 * closer to the accent color than any editor bg — measured, roughly half of
 * the defaults fall below WCAG AA (4.5:1) there. Each color is therefore
 * lightened (dark themes) or darkened (light themes) along its own hue until
 * it clears AA against every background; hue is preserved so the theme's
 * character survives.
 */

import { TinyColor } from "@ctrl/tinycolor";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RgbColor } from "@earendil-works/pi-tui";
import type { BundledTheme, ThemeRegistration } from "shiki";

import { contrastRatio, parseAnsiRgb, parseHexColor, rgbToHex } from "#src/core/color.ts";
import { fnv1a } from "#src/core/fingerprint.ts";

import type { DiffPalette, PaletteTheme } from "./palette.ts";

/** WCAG AA contrast ratio for normal-size text. */
const WCAG_AA = 4.5;

/**
 * The pi theme's `syntax*` color slots — reused from the SDK's
 * `ThemeColor` vocabulary (single source of truth for slot names).
 */
export type PiSyntaxColor = Extract<ThemeColor, `syntax${string}`>;

/**
 * Strip the `syntax` prefix and lowercase the head (`syntaxComment` →
 * `comment`); distributes across the slot union.
 */
type SemanticKeyOf<T extends string> = T extends `syntax${infer Rest}` ? Lowercase<Rest> : never;

/**
 * A semantic syntax color key (config surface form), derived from the SDK's
 * slot names — a new SDK syntax slot surfaces here as a compile error in
 * SEMANTIC_TO_PI's exhaustiveness check, never as a silent gap.
 */
export type SemanticKey = SemanticKeyOf<PiSyntaxColor>;

/** Semantic short key → the pi theme's `syntax*` color name (one source). */
export const SEMANTIC_TO_PI: Record<SemanticKey, PiSyntaxColor> = {
  comment: "syntaxComment",
  keyword: "syntaxKeyword",
  function: "syntaxFunction",
  variable: "syntaxVariable",
  string: "syntaxString",
  number: "syntaxNumber",
  type: "syntaxType",
  operator: "syntaxOperator",
  punctuation: "syntaxPunctuation",
};

/**
 * The semantic keys, in mapping order — drives the config schema's enum and
 * the iteration order behind theme identity hashing.
 */
export const SEMANTIC_KEYS = Object.keys(SEMANTIC_TO_PI) as readonly SemanticKey[];

/**
 * TextMate scopes → pi syntax colors. Modeled on pi's own hljs token mapping
 * (theme.js buildCliHighlightTheme) so pi's diff view and our Shiki view
 * agree on what each token means; scopes broadened where TextMate grammars
 * split finer than hljs does.
 */
const SCOPE_MAP: ReadonlyArray<{ scopes: string[]; color: PiSyntaxColor }> = [
  { scopes: ["comment", "punctuation.definition.comment"], color: "syntaxComment" },
  {
    scopes: ["keyword", "storage.type", "storage.modifier", "entity.name.tag.css"],
    color: "syntaxKeyword",
  },
  {
    scopes: ["entity.name.function", "support.function", "meta.function-call", "variable.function"],
    color: "syntaxFunction",
  },
  {
    scopes: [
      "variable",
      "variable.other",
      "meta.parameter",
      "entity.name.variable",
      "support.variable",
      "entity.other.attribute-name",
    ],
    color: "syntaxVariable",
  },
  {
    scopes: ["string", "string.regexp", "markup.inserted.diff", "markup.deleted.diff"],
    color: "syntaxString",
  },
  {
    scopes: ["constant.numeric", "constant.language", "constant.character.escape"],
    color: "syntaxNumber",
  },
  {
    scopes: ["entity.name.type", "support.type", "support.class", "entity.name.class", "meta.type"],
    color: "syntaxType",
  },
  { scopes: ["keyword.operator", "storage.type.function.arrow"], color: "syntaxOperator" },
  { scopes: ["punctuation", "meta.brace", "entity.name.tag"], color: "syntaxPunctuation" },
];

// ---------------------------------------------------------------------------
// WCAG adjustment
// ---------------------------------------------------------------------------

/**
 * The minimum contrast a color achieves over the background set.
 *
 * @param color - The color to measure.
 * @param backgrounds - The backgrounds to measure against.
 * @returns The smallest contrast ratio.
 */
function minContrast(color: RgbColor, backgrounds: readonly RgbColor[]): number {
  return Math.min(...backgrounds.map((bg) => contrastRatio(color, bg)));
}

/**
 * Nudge a color's HSL lightness toward the palette's safe extreme until it
 * clears WCAG AA over every background. Hue and saturation are preserved.
 * Returns the original color when it already complies. Exported for the
 * pi-theme converter (the AA tool is shared, not forked).
 *
 * @param color - The syntax color to adjust.
 * @param backgrounds - The backgrounds the color must read on.
 * @param towardWhite - Adjust upward (dark palettes) or downward (light).
 * @returns The WCAG-compliant color (original if already compliant).
 */
export function enforceWcag(
  color: RgbColor,
  backgrounds: readonly RgbColor[],
  towardWhite: boolean,
): RgbColor {
  if (minContrast(color, backgrounds) >= WCAG_AA) return color;
  // TinyColor's HSL: h in degrees, s/l in [0, 1]. Keep hue and saturation,
  // sweep lightness in 1% steps: cheap, monotone, deterministic.
  const { h, s, l: start } = new TinyColor(color).toHsl();
  for (let step = 0.01; step <= 1.001; step += 0.01) {
    const l = towardWhite ? Math.min(1, start + step) : Math.max(0, start - step);
    const candidate = rgbOfHsl(h, s, l);
    if (minContrast(candidate, backgrounds) >= WCAG_AA) return candidate;
    if (l >= 1 || l <= 0) break;
  }
  return rgbOfHsl(h, s, towardWhite ? 1 : 0);
}

/**
 * Build an RGB from TinyColor's HSL scale (h in degrees, s/l in [0, 1]).
 *
 * @param h - Hue in degrees [0, 360).
 * @param s - Saturation in [0, 1].
 * @param l - Lightness in [0, 1].
 * @returns The RGB color.
 */
function rgbOfHsl(h: number, s: number, l: number): RgbColor {
  const rgb = new TinyColor({ h, s, l }).toRgb();
  return { r: rgb.r, g: rgb.g, b: rgb.b };
}
// ---------------------------------------------------------------------------
// Theme derivation
// ---------------------------------------------------------------------------

/**
 * Read one syntax color from the pi theme as RGB, or null when absent.
 *
 * @param theme - The pi theme to read from.
 * @param name - The pi theme's `syntax*` color slot.
 * @returns The parsed RGB, or null.
 */
function readSyntaxColor(theme: PaletteTheme, name: PiSyntaxColor): RgbColor | null {
  try {
    return parseAnsiRgb(theme.getFgAnsi(name));
  } catch {
    return null;
  }
}

/**
 * Parse a bg escape to RGB, falling back when it is not truecolor.
 *
 * @param escape - The SGR escape sequence.
 * @param fallback - The color to use when parsing fails.
 * @returns The parsed (or fallback) RGB.
 */
function bgRgbOr(escape: string, fallback: RgbColor): RgbColor {
  return parseAnsiRgb(escape) ?? fallback;
}

/**
 * The renderer backgrounds a syntax color must stay readable on, as RGB.
 *
 * @param palette - The resolved diff palette.
 * @returns The five render backgrounds (base canvas + add/del/emphasis blends; neutral fallback for
 *   background-less palettes).
 */
export function aaCheckBackgrounds(palette: DiffPalette): RgbColor[] {
  const neutral = palette.isLight ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  return [
    bgRgbOr(palette.bgBase, neutral),
    bgRgbOr(palette.bgAdded, neutral),
    bgRgbOr(palette.bgRemoved, neutral),
    bgRgbOr(palette.bgAddedWord, neutral),
    bgRgbOr(palette.bgRemovedWord, neutral),
  ];
}

/**
 * The canvas color's hex — the diff palette's base background when it
 * carries a truecolor value, else the polarity's neutral (the fallback
 * only fires when bgBase is theme-name-based rather than rgb).
 *
 * @param palette - The resolved diff palette.
 * @returns The hex color for editor.background.
 */
function canvasBgHex(palette: DiffPalette): string {
  const bgRgb = parseAnsiRgb(palette.bgBase);
  if (bgRgb) return rgbToHex(bgRgb);
  return palette.isLight ? "#ffffff" : "#000000";
}

/**
 * Build the pi-derived syntax theme. Every one of the pi theme's nine syntax
 * colors must resolve (they are required in pi's theme schema); a single
 * miss returns null — the caller then renders UNHIGHLIGHTED (honest,
 * no substitute fallback; ADR 0006's follower path). User
 * color patches replace their keys VERBATIM (enforcement boundary: user
 * colors are never AA-enforced); the rest walk AA as usual.
 *
 * @param theme - The active pi theme.
 * @param palette - The resolved diff palette (backgrounds + lightness bit).
 * @param themeKey - The palette's cache key; keys both the theme name and
 *   the caller's memo so hot theme switches invalidate correctly.
 * @param userColors - Semantic color patches (the syntaxTheme object's
 *   effective colors for the current polarity), or undefined.
 * @returns The TextMate theme, or null when the theme lacks syntax colors.
 */
export function buildPiSyntaxTheme(
  theme: PaletteTheme,
  palette: DiffPalette,
  themeKey: string,
  userColors?: SemanticColors,
): PiSyntaxTheme | null {
  const raw = new Map<SemanticKey, RgbColor>();
  for (const key of SEMANTIC_KEYS) {
    const rgb = readSyntaxColor(theme, SEMANTIC_TO_PI[key]);
    if (!rgb) return null;
    raw.set(key, rgb);
  }

  const backgrounds = aaCheckBackgrounds(palette);
  const adjusted = new Map<SemanticKey, string>();
  for (const [key, rgb] of raw) {
    const patched = userColors?.[key];
    if (patched) {
      adjusted.set(key, patched); // user color: verbatim
    } else {
      adjusted.set(key, rgbToHex(enforceWcag(rgb, backgrounds, !palette.isLight)));
    }
  }

  const fgHex = rgbToHex(raw.get("punctuation") ?? { r: 128, g: 128, b: 128 });
  // The canvas color's hex: the parsed palette bg, else the polarity's
  // neutral (the fallback only fires when bgBase carries no truecolor).
  const bgHex = canvasBgHex(palette);
  // Stable identity for Shiki's name-based dedup: derived colors + theme key
  // + user patches (so config reloads produce a fresh name/cache entry).
  const identity = `${[...adjusted.values()].join("")}|${themeKey}|${JSON.stringify(userColors ?? {})}`;

  return {
    name: `pi-${palette.isLight ? "light" : "dark"}-${fnv1a(identity)}`,
    type: palette.isLight ? "light" : "dark",
    colors: {
      "editor.background": bgHex,
      "editor.foreground": adjusted.get("punctuation") ?? fgHex,
    },
    tokenColors: SCOPE_MAP.map(({ scopes, color }) => ({
      scope: [...scopes],
      settings: { foreground: adjusted.get(semanticKeyOfPiName(color)) ?? fgHex },
    })),
  };
}

// ---------------------------------------------------------------------------
// Patches, enforcement, and inline variants (ADR 0002)
// ---------------------------------------------------------------------------

/**
 * Semantic syntax color overrides: only listed keys deviate (the one type
 * for both the config schema's `colors` and the enforcement pipeline's
 * patches — same shape, one name).
 */
export type SemanticColors = Partial<Record<SemanticKey, string>>;

/**
 * What the render path feeds shiki: a bundled theme id (an AA-clean
 * bundled name, passed by id) or a materialized theme object.
 */
export type ShikiThemeInput = BundledTheme | MaterializedTheme;

/**
 * A MATERIALIZED theme: the intake's output — registration name
 * normalized, polarity settled ("light" | "dark"), translucent token
 * colors flattened. The enforcement and render paths consume this form.
 */
export type MaterializedTheme = ThemeRegistration & {
  name: string;
  type: "light" | "dark";
  /**
   * The file content's fingerprint (file-channel themes only): rides the
   * theme so cache keys can include it — a name alone serves stale colors
   * after the source file is edited between sessions.
   */
  contentFingerprint?: string;
};

/**
 * The pi-derived theme the builder emits — its own contract, not an
 * alias: a full tokenColors array of string-scope rules with foregrounds
 * (the enforcement and tests index into exactly this shape), plus the
 * informational colors dict.
 */
export interface PiSyntaxTheme {
  /** Unique registration name (deduped by Shiki on this). */
  name: string;
  /** Light or dark — mirrors the pi theme. */
  type: "light" | "dark";
  /** Editor colors (informational for ANSI rendering). */
  colors: Record<string, string>;
  /** Token colors, most specific last. */
  tokenColors: { scope: string[]; settings: { foreground: string } }[];
}

/**
 * The scope prefixes per semantic key, flattened for classification and
 * sorted longest-first (TextMate semantics: the longest matching prefix
 * wins — `keyword.operator.new` → operator, not keyword; `entity.name.tag.css`
 * → keyword while `entity.name.tag` → punctuation).
 */
const SEMANTIC_SCOPE_PREFIXES: ReadonlyArray<{ key: SemanticKey; scope: string }> =
  SCOPE_MAP.flatMap(({ scopes, color }) =>
    scopes.map((scope) => ({ key: semanticKeyOfPiName(color), scope })),
  ).toSorted((a, b) => b.scope.length - a.scope.length);

/**
 * Map a pi syntax color name back to its semantic key — the runtime mirror
 * of the type-level derivation (`SemanticKeyOf<PiSyntaxColor>`): the slot
 * name minus the `syntax` prefix, lowercased. Total by construction: every
 * `PiSyntaxColor` member derives a key, including SDK slots added before
 * SEMANTIC_TO_PI catches up.
 *
 * @param piName - The pi theme's `syntax*` color name.
 * @returns The semantic key.
 */
function semanticKeyOfPiName(piName: PiSyntaxColor): SemanticKey {
  return piName.slice(6).toLowerCase() as SemanticKey;
}
/**
 * Classify one scope string into a semantic key by SCOPE_MAP prefixes: a scope
 * belongs to a group when it equals the group prefix or extends it
 * ("keyword.control.import" → keyword), with the longest matching prefix
 * winning ("storage.type.function.arrow" → operator, not keyword). Exported
 * for the converter's extraction (per-scope granularity) and shared with
 * ruleSemanticKeys.
 *
 * @param scope - The scope to classify.
 * @returns The matching semantic key, or null when unclassified.
 */
export function scopeSemanticKey(scope: string): SemanticKey | null {
  for (const { key, scope: prefix } of SEMANTIC_SCOPE_PREFIXES) {
    if (scope === prefix || scope.startsWith(`${prefix}.`)) return key;
  }
  return null;
}

/**
 * The semantic keys a rule touches (a rule's scopes may span groups).
 * Exported for the converter (nine-color extraction walks the same
 * classification).
 *
 * @param rule - The tokenColors rule.
 * @returns The distinct semantic keys its scopes classify into.
 */
export function ruleSemanticKeys(rule: { scope?: string | readonly string[] }): Set<SemanticKey> {
  // TextMate rules may carry one scope, an array, or a comma-separated string.
  const scopes = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
  const keys = new Set<SemanticKey>();
  for (const scope of scopes) {
    const key = scopeSemanticKey(scope.trim());
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Rewrite a TextMate theme's rules so the patched semantic groups carry the
 * user's colors verbatim (rule rewriting — appended broad-scope rules would
 * lose to the base theme's specific scopes under TextMate specificity).
 * Immutable: the input theme is never modified.
 *
 * @param theme - The base theme to patch.
 * @param patches - The semantic color patches.
 * @param identity - Extra identity input for the name hash.
 * @returns The patched theme (new object), or the input when no rule matches.
 */
export function applySemanticPatches(
  theme: MaterializedTheme,
  patches: SemanticColors,
  identity: string,
): MaterializedTheme {
  const patchEntries = Object.entries(patches);
  if (patchEntries.length === 0 || !theme.tokenColors) return theme;
  const patchMap = new Map(patchEntries);
  let changed = false;
  const tokenColors = theme.tokenColors.map((rule) => {
    const keys = ruleSemanticKeys(rule);
    const hit = [...keys].find((key) => patchMap.has(key));
    if (!hit || !rule.settings?.foreground) return rule;
    changed = true;
    return { ...rule, settings: { ...rule.settings, foreground: patchMap.get(hit) } };
  });
  if (!changed) return theme;
  return {
    ...theme,
    name: `${theme.name}-patch-${fnv1a(`${identity}|${JSON.stringify(patches)}`)}`,
    tokenColors,
  };
}

/**
 * Build an inline variant-mode theme from semantic colors (variant mode of
 * the syntaxTheme object): the author's nine colors become a TextMate theme
 * through the same scope mapping the pi-derived theme uses — rendered
 * VERBATIM (user colors are never AA-enforced).
 *
 * @param variantColors - The variant's semantic colors (at least one).
 * @param type - The variant's polarity.
 * @param identity - Extra identity input for the name hash.
 * @returns The TextMate theme.
 */
export function buildSemanticTheme(
  variantColors: SemanticColors,
  type: "light" | "dark",
  identity: string,
): MaterializedTheme {
  return {
    name: `inline-${type}-${fnv1a(`${identity}|${JSON.stringify(variantColors)}`)}`,
    type,
    tokenColors: SCOPE_MAP.map(({ scopes, color }) => {
      const key = semanticKeyOfPiName(color);
      const foreground = variantColors[key] ?? "#888888";
      return { scope: [...scopes], settings: { foreground } };
    }),
  };
}

/**
 * Enforce WCAG AA on every fg color of a TextMate theme (bundled names
 * and the fallback pair — the colors WE choose). Each distinct foreground —
 * tokenColors rules and the editor default fg — walks HSL lightness toward
 * the palette-safe extreme until it clears AA on every background; hue and
 * fontStyle are preserved, non-hex colors are skipped. Immutable: the input
 * theme is never modified (bundled-theme loaders return shared references).
 *
 * @param theme - The theme to enforce.
 * @param backgrounds - The effective renderer backgrounds.
 * @param towardWhite - Adjust upward (dark palettes) or downward (light).
 * @returns The enforced theme (new object), or the input when already AA.
 */
export function enforceThemeColors(
  theme: MaterializedTheme,
  backgrounds: readonly RgbColor[],
  towardWhite: boolean,
): MaterializedTheme {
  const cache = new Map<string, string>();
  /**
   * Enforce one hex color, memoized per hex.
   *
   * @param hex - The color to enforce.
   * @returns The enforced hex.
   */
  const enforceHex = (hex: string): string => {
    const memoized = cache.get(hex);
    if (memoized !== undefined) return memoized;
    const rgb = parseHexColor(hex);
    const adjusted = rgb ? rgbToHex(enforceWcag(rgb, backgrounds, towardWhite)) : hex;
    cache.set(hex, adjusted);
    return adjusted;
  };

  let changed = false;
  const tokenColors = theme.tokenColors?.map((rule) => {
    const fg = rule.settings?.foreground;
    if (!fg || !fg.startsWith("#")) return rule;
    const adjusted = enforceHex(fg);
    if (adjusted === fg) return rule;
    changed = true;
    return { ...rule, settings: { ...rule.settings, foreground: adjusted } };
  });

  let colors = theme.colors;
  const defaultFg = theme.colors?.["editor.foreground"];
  if (defaultFg?.startsWith("#")) {
    const adjusted = enforceHex(defaultFg);
    if (adjusted !== defaultFg) {
      changed = true;
      colors = { ...theme.colors, "editor.foreground": adjusted };
    }
  }

  if (!changed) return theme;
  const bgKey = fnv1a(backgrounds.map((bg) => rgbToHex(bg)).join("|"));
  return { ...theme, name: `${theme.name}-aa-${bgKey}`, tokenColors, colors };
}
