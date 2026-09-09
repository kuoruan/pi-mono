/**
 * The shiki → pi theme converter (ADR 0006): ONE pure function turning a
 * materialized shiki theme into a pi theme JSON document. This is where a
 * selected theme's identity crosses into pi's own vocabulary — the canvas,
 * the state colors, the diff roots, and the nine syntax colors are all
 * decided HERE, at generation time (never at render time).
 *
 * Two AA surfaces, never confused (the converter owns only the first):
 *
 * - Converter AA: chrome slots (success/error/warning/accent, the fg ladder) are enforced against the
 *   CANVAS — pi paints its own chrome on the canvas, so those colors must read there. The
 *   user-theme channel's conversion opts OUT (enforceAa: false — author colors verbatim, the
 *   enforcement boundary: colors YOU set render verbatim); the bundled ships are
 *   pi-pigment-supplied and keep the sweep.
 * - Runtime AA: token colors are enforced at render time by enforceThemeColors against the palette's
 *   blend backgrounds (the tint ladders). The nine syntax colors in the FILE serve pi's own
 *   markdown code rendering — same source, different precision than the full tokenColors the diff
 *   pipeline loads.
 *
 * Output shape: the 53 required + 3 optional pi tokens (themes.md), all
 * flat hex (no vars indirection — the generator has no authors), plus the
 * optional `export` section derived from the canvas. The token lists are
 * pinned to pi's own public types at compile time by the guard below —
 * upstream additions/removals/renames break the build with the offending
 * token named in the error, so the lists are maintained, not hand-synced
 * from docs.
 */

import type { RgbColor } from "@earendil-works/pi-tui";

import { isLightRgb, mixRgb, parseOpaqueHex, parseRootColor, rgbToHex } from "#src/core/color.ts";

import {
  enforceWcag,
  scopeSemanticKey,
  SEMANTIC_TO_PI,
  type MaterializedTheme,
  type SemanticColors,
  type SemanticKey,
} from "./syntax-theme.ts";

/** The pi theme colors document the converter emits (mirrors themes.md). */
export interface PiThemeColors {
  [token: string]: string;
}

/** The pi theme JSON document the converter emits. */
export interface PiThemeJson {
  $schema: string;
  name: string;
  colors: PiThemeColors;
  export?: PiThemeExport;
}

/** The optional HTML-export section (page/card/info surfaces). */
export interface PiThemeExport {
  pageBg: string;
  cardBg: string;
  infoBg: string;
}

/** The 53 required pi color tokens, in themes.md order. */
export const PI_REQUIRED_TOKENS = [
  // Core UI (13)
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  // Backgrounds & content (11)
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  // Markdown (10)
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  // Tool diffs (3)
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  // Syntax (9)
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  // Thinking levels (6)
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  // Bash mode (1)
  "bashMode",
] as const;

/** The 3 optional pi color tokens (with documented fallbacks). */
export const PI_OPTIONAL_TOKENS = ["thinkingMax", "searchMatchBg", "searchMatchText"] as const;

/** Pi's theme schema URL (editor validation for hand-edited copies). */
const PI_THEME_SCHEMA =
  "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

/** A color that failed conversion — reported, never half-emitted. */
interface ConverterIssue {
  /** The human-readable problem. */
  message: string;
}

/**
 * The hue-anchored state colors per polarity: green/red/amber references
 * that the WCAG sweep nudges toward the canvas until readable. These are
 * the polarity's canonical hues, not theme-derived — the theme's own
 * greens/reds belong to the DIFF roots (semantic), not the state colors
 * (functional: success is green, error is red, by convention).
 */
const STATE_HUES = {
  light: { success: "#1a7f37", error: "#c62828", warning: "#9a6700" },
  dark: { success: "#3fb950", error: "#f85149", warning: "#d29922" },
} as const;

/**
 * Parse an optional slot value into an opaque RGB: undefined for absent
 * or malformed input — the silent-fallback precedent (optional slots
 * degrade to their computed ladder versions, never fail conversion).
 *
 * @param value - The raw slot value.
 * @returns The RGB, or null/undefined.
 */
function optionalOpaqueHex(value: string | undefined): RgbColor | null | undefined {
  return typeof value === "string" ? parseOpaqueHex(value) : undefined;
}

/**
 * STATE_HUES literals are opaque hex by construction — the parse is
 * total; a miss is an internal inconsistency, never a theme problem.
 *
 * @param hex - The state hue hex.
 * @returns The RGB.
 */
function stateHueRgb(hex: string): RgbColor {
  const rgb = parseOpaqueHex(hex);
  if (!rgb) throw new Error(`unreachable hue: ${hex}`);
  return rgb;
}

/**
 * Extract the theme's nine syntax colors by scope classification. The
 * BROADEST declared scope wins each key (the author's category intent —
 * narrow per-language exceptions must not hijack the category's
 * representative color; TextMate's longest-match answers "what color is
 * THIS token", not "what is the comment class's color"). Equal-length
 * tied scopes keep the first rule in file order. Every scope of a rule
 * competes individually (an array rule's shortest element is the rule's
 * bid for that key).
 *
 * @param theme - The materialized theme.
 * @returns The found semantic colors (partial — missing keys fall back).
 */
function extractSyntaxColors(theme: MaterializedTheme): Partial<SemanticColors> {
  const found = new Map<SemanticKey, string>();
  const breadth = new Map<SemanticKey, number>();
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const scopes = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
    for (const entry of scopes) {
      const scope = entry.trim();
      if (!scope) continue;
      const key = scopeSemanticKey(scope);
      if (!key) continue;
      const current = breadth.get(key);
      if (current === undefined || scope.length < current) {
        found.set(key, rgbToHex(rgb));
        breadth.set(key, scope.length);
      }
    }
  }
  return Object.fromEntries(found);
}

/**
 * The most saturated of the candidate token colors — the theme's accent.
 *
 * @param theme - The materialized theme.
 * @param fallback - The polarity default when no token qualifies.
 * @returns The accent RGB.
 */
function pickAccent(theme: MaterializedTheme, fallback: RgbColor): RgbColor {
  let best: { rgb: RgbColor; saturation: number } | undefined;
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    // Mid-lightness guard: near-black and near-white tokens (punctuation,
    // plain fg) never become accents however saturated numerically.
    const lightness = (max + min) / 510;
    if (lightness < 0.15 || lightness > 0.9) continue;
    if (!best || saturation > best.saturation) best = { rgb, saturation };
  }
  return best?.rgb ?? fallback;
}

/**
 * Diff-root greens/reds from the theme's tokens.
 *
 * @param theme - The materialized theme.
 * @param isLight - The canvas polarity.
 * @returns The added/removed hex candidates (with polarity fallbacks).
 */
function extractDiffColors(
  theme: MaterializedTheme,
  isLight: boolean,
): { added?: string; removed?: string } {
  const candidates = { added: [] as RgbColor[], removed: [] as RgbColor[] };
  for (const rule of theme.tokenColors ?? []) {
    const rgb = optionalOpaqueHex(rule.settings?.foreground);
    if (!rgb) continue;
    const { r, g, b } = rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) continue; // gray: neither
    const saturation = (max - min) / max;
    if (saturation < 0.25) continue; // too gray to read as a hue
    if (g === max && g - r > 20 && g - b > 20) {
      candidates.added.push(rgb);
    } else if (r === max && r - g > 20 && r - b > 20) {
      candidates.removed.push(rgb);
    }
  }
  const state = isLight ? STATE_HUES.light : STATE_HUES.dark;
  return {
    added: mostSaturatedHex(candidates.added) ?? state.success,
    removed: mostSaturatedHex(candidates.removed) ?? state.error,
  };
}

/**
 * Mix a color toward the canvas by ratio (the fg ladder's building block).
 *
 * @param color - The source color.
 * @param canvas - The canvas to fade into.
 * @param ratio - The fade ratio (0 = color, 1 = canvas).
 * @returns The mixed color.
 */
function towardCanvas(color: RgbColor, canvas: RgbColor, ratio: number): RgbColor {
  return mixRgb(canvas, color, 1 - ratio);
}

/**
 * Tint the CANVAS with a little of a color (the background slots' mix:
 * canvas stays the body, the color is the hint). The mirror of
 * towardCanvas — kept as its own name because confusing the two directions
 * is exactly the bug this split prevents (a bg slot taking towardCanvas
 * renders 97% foreground as a background — gray-on-gray text).
 *
 * @param color - The tint color (the fg, usually).
 * @param canvas - The canvas (the body).
 * @param amount - The tint amount (0 = pure canvas, 1 = pure color).
 * @returns The tinted canvas.
 */
function tintCanvas(color: RgbColor, canvas: RgbColor, amount: number): RgbColor {
  return mixRgb(canvas, color, amount);
}

/**
 * The most saturated color in a list (the theme's canonical hue for a
 * diff-root side).
 *
 * @param list - The candidate RGBs.
 * @returns The most saturated hex, or undefined for an empty list.
 */
function mostSaturatedHex(list: RgbColor[]): string | undefined {
  if (list.length === 0) return undefined;
  let best = list[0];
  let bestSat = -1;
  for (const rgb of list) {
    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat > bestSat) {
      bestSat = sat;
      best = rgb;
    }
  }
  return rgbToHex(best);
}

/** Author-declared diff-root overrides (the TextMate theme file's `diff` key). */
export interface DiffRootOverrides {
  /** The added-side text root (opaque hex; a tint's hue stands in when absent). */
  added?: string;
  /** The removed-side text root (opaque hex; a tint's hue stands in when absent). */
  removed?: string;
  /** The added-side tint (8-digit hex) — its hue becomes the side's text root when `added` is unset. */
  addedTint?: string;
  /**
   * The removed-side tint (8-digit hex) — its hue becomes the side's text root when `removed` is
   * unset.
   */
  removedTint?: string;
}

/**
 * Strip a tint's alpha channel: the 8-digit hue as an opaque line color —
 * the fallback a side's text root takes from its tint (ADR 0003: the tint
 * anchors the emphasis ladder; its hue IS the author's line-color intent).
 *
 * @param tint - The 8-digit tint hex, or undefined.
 * @returns The opaque hue, or undefined when no tint.
 */
function tintHue(tint: string | undefined): string | undefined {
  if (!tint) return undefined;
  const rgb = parseRootColor(tint);
  return rgb ? rgbToHex(rgb.rgb) : undefined;
}

/**
 * The conversion options: author-declared diff-root overrides and the AA
 * switch (the user-theme channel opts out — colors render verbatim).
 */
export interface ConvertOptions {
  /** Author-declared diff-root overrides (author intent beats token extraction). */
  diff?: DiffRootOverrides;
  /** The default true keeps the AA sweep; the user channel passes false. */
  enforceAa?: boolean;
}

/**
 * Convert a materialized shiki theme into a pi theme JSON document.
 * Themes missing `editor.background` or `type` are rejected (an issue is
 * returned) — a pi theme without a canvas is not a theme.
 *
 * @param theme - The materialized shiki theme (verbatim, flattened).
 * @param name - The pi theme name (the registered, prefixed identity).
 * @param options - The conversion options.
 * @returns The document and issues; doc is undefined when unconvertible.
 */
export function convertToPiTheme(
  theme: MaterializedTheme,
  name: string,
  options?: ConvertOptions,
): { doc: PiThemeJson | undefined; issues: ConverterIssue[] } {
  const enforceAa = options?.enforceAa ?? true;
  const diffOverrides = options?.diff;
  const issues: ConverterIssue[] = [];
  // The canvas is the theme's own editor.background — never a root
  // (ADR 0006): the generated theme's canvas IS its editor background.
  const canvas = optionalOpaqueHex(theme.colors?.["editor.background"]);
  if (!canvas) {
    return {
      doc: undefined,
      issues: [{ message: `theme "${theme.name}" has no usable editor.background — skipped.` }],
    };
  }
  if (theme.type !== "light" && theme.type !== "dark") {
    return {
      doc: undefined,
      issues: [{ message: `theme "${theme.name}" has no type — skipped.` }],
    };
  }
  const isLight = isLightRgb(canvas);
  const state = isLight ? STATE_HUES.light : STATE_HUES.dark;

  // Foreground: editor.foreground, else the polarity's neutral gray.
  const neutralFg = isLight ? { r: 0x33, g: 0x33, b: 0x33 } : { r: 0xcc, g: 0xcc, b: 0xcc };
  const fg = optionalOpaqueHex(theme.colors?.["editor.foreground"]) ?? neutralFg;
  const successRgb = stateHueRgb(state.success);
  const errorRgb = stateHueRgb(state.error);
  const warningRgb = stateHueRgb(state.warning);

  // The AA backgrounds for chrome slots: the canvas itself (pi paints
  // chrome directly on it). The subtle message-bg tints are close enough
  // to the canvas that canvas-level AA carries them. ENFORCEMENT SCOPE:
  // only the colors WE choose (state colors, accent, diff roots, syntax
  // fallbacks) — the theme's own fg stays verbatim (its identity, the
  // same policy as the runtime: user colors are never enforced). pi's
  // built-ins ship sub-AA texts themselves (light's toolDiffAdded is
  // 3.72) — softness is a deliberate look, not a bug we must fix.
  const aaBackgrounds: readonly RgbColor[] = [canvas];
  const enforce = (hex: string): string => {
    // The user-theme channel converts with the sweep OFF — verbatim
    // author colors are its whole point (the same boundary the runtime
    // applies: user colors are never enforced).
    if (!enforceAa) return hex;
    const rgb = parseOpaqueHex(hex);
    return rgb ? rgbToHex(enforceWcag(rgb, aaBackgrounds, !isLight)) : hex;
  };

  // The fg ladder.
  const muted = towardCanvas(fg, canvas, 0.3);
  const dim = towardCanvas(fg, canvas, 0.55);
  const thinkingText = towardCanvas(fg, canvas, 0.4);
  const border = towardCanvas(fg, canvas, 0.7);
  const borderMuted = towardCanvas(fg, canvas, 0.85);

  // Accent: the theme's most saturated token color, AA-protected.
  const accentFallback = isLight ? { r: 0x09, g: 0x69, b: 0xda } : { r: 0x58, g: 0xa6, b: 0xff };
  const accentRgb = pickAccent(theme, accentFallback);
  const accent = enforce(rgbToHex(accentRgb));

  // State colors: polarity hues, AA-protected.
  const success = enforce(state.success);
  const error = enforce(state.error);
  const warning = enforce(state.warning);

  // Syntax nine: extraction with fg-ladder fallbacks, AA-protected.
  const extracted = extractSyntaxColors(theme);
  const syntax: PiThemeColors = {};
  const syntaxDefaults: Record<SemanticKey, RgbColor> = {
    comment: muted,
    keyword: accentRgb,
    function: accentRgb,
    variable: fg,
    string: fg,
    number: accentRgb,
    type: accentRgb,
    operator: fg,
    punctuation: fg,
  };
  for (const key of Object.keys(SEMANTIC_TO_PI) as SemanticKey[]) {
    syntax[SEMANTIC_TO_PI[key]] = enforce(extracted[key] ?? rgbToHex(syntaxDefaults[key]));
  }

  // Diff roots: the file's explicit diff key (author intent) beats token
  // extraction (greens/reds), which beats the polarity-hue fallbacks.
  const extractedDiff = extractDiffColors(theme, isLight);
  const diffAdded = enforce(
    diffOverrides?.added ??
      tintHue(diffOverrides?.addedTint) ??
      extractedDiff.added ??
      state.success,
  );
  const diffRemoved = enforce(
    diffOverrides?.removed ??
      tintHue(diffOverrides?.removedTint) ??
      extractedDiff.removed ??
      state.error,
  );
  const diffContext = enforce(rgbToHex(muted));

  // Thinking ladder: dim → fg, seven steps + max.
  const thinkingSteps = [
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
  ];
  const thinking: Record<string, string> = {};
  thinkingSteps.forEach((token, i) => {
    const t = i / (thinkingSteps.length - 1); // 0 = dim, 1 = fg
    thinking[token] = rgbToHex(mixRgb(dim, fg, t));
  });

  // Selected / search backgrounds take the theme's own declarations when
  // present (author colors, verbatim — outside the AA sweep), else the
  // computed canvas tints.
  const selectedBgRgb =
    optionalOpaqueHex(theme.colors?.["editor.selectionBackground"]) ?? tintCanvas(fg, canvas, 0.12);
  const searchMatchBgRgb =
    optionalOpaqueHex(theme.colors?.["editor.findMatchBackground"]) ?? tintCanvas(fg, canvas, 0.2);
  const searchMatchTextRgb = optionalOpaqueHex(theme.colors?.["editor.findMatchForeground"]) ?? fg;
  const colors: PiThemeColors = {
    // Core UI
    accent,
    border: rgbToHex(border),
    borderAccent: accent,
    borderMuted: rgbToHex(borderMuted),
    success,
    error,
    warning,
    muted: rgbToHex(muted),
    dim: rgbToHex(dim),
    text: rgbToHex(fg),
    thinkingText: rgbToHex(thinkingText),
    scrollbarTrack: rgbToHex(towardCanvas(fg, canvas, 0.75)),
    scrollbarThumb: rgbToHex(towardCanvas(fg, canvas, 0.5)),
    // Backgrounds & content: status-colored tool boxes — pending = the
    // exact canvas, zero shift (no status hint while a call streams);
    // success and error take the polarity's state hues at the same
    // polarity-gated ratio (visible on light canvases, subtle on dark).
    selectedBg: rgbToHex(selectedBgRgb),
    searchMatchBg: rgbToHex(searchMatchBgRgb),
    searchMatchText: rgbToHex(searchMatchTextRgb),
    userMessageBg: rgbToHex(tintCanvas(fg, canvas, 0.03)),
    userMessageText: rgbToHex(fg),
    customMessageBg: rgbToHex(tintCanvas(fg, canvas, 0.05)),
    customMessageText: rgbToHex(fg),
    customMessageLabel: accent,
    toolPendingBg: rgbToHex(canvas),
    toolSuccessBg: rgbToHex(mixRgb(canvas, successRgb, isLight ? 0.25 : 0.1)),
    // The error tint's alpha is polarity-gated: 10% reads on dark
    // canvases, but on light canvases 10% of the error red over
    // near-white is imperceptible — the aborted-tool frame looked plain
    // white (the "create ✓ cancel = white bg" report). Light canvases
    // take a stronger tint so the error surface stays visible in
    // truecolor terminals, where the 256-color quantization no longer
    // rescues the subtle blend.
    toolErrorBg: rgbToHex(mixRgb(canvas, errorRgb, isLight ? 0.25 : 0.1)),
    toolTitle: rgbToHex(fg),
    toolOutput: rgbToHex(fg),
    // Markdown
    mdHeading: accent,
    mdLink: accent,
    mdLinkUrl: rgbToHex(muted),
    mdCode: accent,
    mdCodeBlock: rgbToHex(fg),
    mdCodeBlockBorder: rgbToHex(muted),
    mdQuote: rgbToHex(muted),
    mdQuoteBorder: rgbToHex(border),
    mdHr: rgbToHex(borderMuted),
    mdListBullet: accent,
    // Tool diffs
    toolDiffAdded: diffAdded,
    toolDiffRemoved: diffRemoved,
    toolDiffContext: diffContext,
    // Syntax
    ...syntax,
    // Thinking
    ...thinking,
    // Bash mode
    bashMode: warning,
  };

  return {
    doc: {
      $schema: PI_THEME_SCHEMA,
      name,
      colors,
      export: {
        pageBg: rgbToHex(canvas),
        cardBg: rgbToHex(tintCanvas(fg, canvas, 0.04)),
        infoBg: rgbToHex(mixRgb(canvas, warningRgb, 0.08)),
      },
    },
    issues,
  };
}
