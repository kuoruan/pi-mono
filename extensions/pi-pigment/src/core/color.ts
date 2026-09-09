/**
 * Pure color math: the RGB/hex/ANSI-color conversions and WCAG measures
 * the palette and syntax themes derive from. No SGR escape production
 * lives here (ansi.ts owns that) — everything in this module maps colors
 * to colors or numbers. Backed by @ctrl/tinycolor (WCAG contrast is
 * bit-identical to the spec; see ADR 0001 for why colord was rejected).
 */

import { readability, TinyColor } from "@ctrl/tinycolor";
import type { RgbColor } from "@earendil-works/pi-tui";

/** The 6×6×6 color-cube channel values of the XTerm 256-color palette. */
const CUBE_CHANNELS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Decode an XTerm 256-color index (16-231 cube, 232-255 grayscale) into RGB.
 * Indices 0-15 (system colors) have no portable RGB mapping — null.
 *
 * @param index - The 256-color palette index.
 * @returns The decoded RGB, or null for system colors.
 */
function decodeAnsi256(index: number): RgbColor | null {
  if (index < 16 || index > 255) return null;
  if (index >= 232) {
    const gray = 8 + 10 * (index - 232);
    return { r: gray, g: gray, b: gray };
  }
  const i = index - 16;
  return {
    r: CUBE_CHANNELS[Math.floor(i / 36)],
    g: CUBE_CHANNELS[Math.floor(i / 6) % 6],
    b: CUBE_CHANNELS[i % 6],
  };
}

/** The ESC control character an SGR sequence starts with. */
const ESC = "\u001b";

/**
 * Parse an ANSI color sequence into RGB: truecolor (`38;2;r;g;b` /
 * `48;2;r;g;b`) directly, 256-color (`38;5;n` / `48;5;n`) through the XTerm
 * cube/grayscale tables. Returns null for anything else (16-color codes,
 * named, or malformed input) — no color library provides this direction,
 * and pi themes hand us escapes (truecolor or 256-color, per terminal
 * capability).
 *
 * @param ansi - An SGR escape sequence.
 * @returns The parsed RGB, or null.
 */
export function parseAnsiRgb(ansi: string): RgbColor | null {
  const truecolor = ansi.match(new RegExp(`${ESC}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
  if (truecolor) {
    return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
  }
  const indexed = ansi.match(new RegExp(`${ESC}\\[(?:38|48);5;(\\d+)m`));
  if (indexed) return decodeAnsi256(Number(indexed[1]));
  return null;
}

/** A parsed hex form: the channels plus the form TinyColor recognized. */
export interface ParsedHex {
  /** The color's RGB channels. */
  rgb: RgbColor;
  /** Alpha in [0, 1] — 1 for the #rgb/#rrggbb (no-alpha) forms. */
  alpha: number;
  /** Whether the input carried an alpha channel (#rgba / #rrggbbaa). */
  isAlphaForm: boolean;
}

/**
 * Strict hex-shape guard — TinyColor is lenient where our surfaces are
 * not: it accepts unprefixed hex ("fff") and surrounding whitespace; the
 * config/theme intakes require a leading `#` and no padding.
 *
 * @param input - The candidate string.
 * @returns Whether the shape is exactly `#` + hexadecimal digits.
 */
function isTightHex(input: string): boolean {
  return input.startsWith("#") && input === input.trim();
}

/**
 * Parse any `#`-prefixed hex form — `#rgb`/`#rrggbb` (opaque) and
 * `#rgba`/`#rrggbbaa` (alpha-carrying — TinyColor expands the shorthands
 * and converts) — into its channels. Everything else (names, rgb()/hsl()
 * strings, unprefixed hex, whitespace padding, malformed input) returns
 * null.
 *
 * @param input - The candidate hex string.
 * @returns The parsed channels, or null.
 */
export function parseHexForm(input: string): ParsedHex | null {
  if (!isTightHex(input)) return null;
  const color = new TinyColor(input);
  if (!color.isValid || (color.format !== "hex" && color.format !== "hex8")) return null;
  const { r, g, b, a } = color.toRgb();
  return { rgb: { r, g, b }, alpha: a, isAlphaForm: color.format === "hex8" };
}

/**
 * Parse a `#rrggbb` hex color into RGB (the config surface's color
 * format). TinyColor-backed; returns null for anything else (3/4/8-digit
 * forms, names, malformed input).
 *
 * @param hex - The hex string.
 * @returns The parsed RGB, or null.
 */
export function parseHexColor(hex: string): RgbColor | null {
  const parsed = parseHexForm(hex);
  return parsed && !parsed.isAlphaForm && hex.length === 7 ? parsed.rgb : null;
}

/**
 * Is the string exactly an opaque `#rrggbb` color (the semantic-slot and
 * global-background format; a 3-digit shorthand is NOT exact — surfaces
 * that accept it use {@link parseOpaqueHex}).
 *
 * @param hex - The candidate string.
 * @returns Whether it is the exact 6-digit opaque form.
 */
export function isOpaqueHex6(hex: string): boolean {
  const parsed = parseHexForm(hex);
  return parsed !== null && !parsed.isAlphaForm && hex.length === 7;
}

/**
 * Is the string exactly an alpha-carrying `#rrggbbaa` color (the bundled
 * theme token flattening requires the 8-digit form; the `#rgba` shorthand
 * is NOT exact — surfaces that accept it use {@link parseHexForm}).
 *
 * @param hex - The candidate string.
 * @returns Whether it is the exact 8-digit alpha form.
 */
export function isAlphaHex8(hex: string): boolean {
  const parsed = parseHexForm(hex);
  return parsed !== null && parsed.isAlphaForm && hex.length === 9;
}

/**
 * Parse an opaque hex accepting 3-digit shorthand too (bundled themes
 * ship a few — github-light's `#fff`, vitesse-black's `#000`): the
 * shorthand expands to its 6-digit form.
 *
 * @param hex - The `#rgb` or `#rrggbb` string.
 * @returns The RGB triple, or null when unparseable.
 */
export function parseOpaqueHex(hex: string): RgbColor | null {
  const parsed = parseHexForm(hex);
  return parsed && !parsed.isAlphaForm ? parsed.rgb : null;
}

/**
 * Render an RGB triple as a lowercase `#rrggbb` hex string.
 *
 * @param rgb - The RGB channels.
 * @returns The `#rrggbb` string (TinyColor-backed).
 */
export function rgbToHex(rgb: RgbColor): string {
  return new TinyColor(rgb).toHexString();
}

/**
 * Composite one hex color (6- or 8-digit) over a base — the 8-digit form
 * carries an alpha channel (VS Code theme token colors use it for
 * translucent punctuation etc.). Delegates to TinyColor's `onBackground`
 * (bit-identical alpha blending, validated against the manual math).
 *
 * @param hex - The color (`#rrggbb` or `#rrggbbaa`; others return null).
 * @param base - The opaque base to composite over.
 * @returns The composited RGB, or null for unparseable input.
 */
export function compositeHexOver(hex: string, base: RgbColor): RgbColor | null {
  const top = new TinyColor(hex);
  if (!top.isValid) return null;
  const over = top.onBackground(new TinyColor(base)).toRgb();
  return { r: over.r, g: over.g, b: over.b };
}

/** A diff-root color: an RGB hue plus an optional alpha channel. */
export interface RootColor {
  /** The color's RGB channels. */
  rgb: RgbColor;
  /** Alpha in [0,1]; 1 for opaque 6-digit hex, < 1 for 8-digit `#rrggbbaa`. */
  alpha: number;
}

/**
 * Parse a diff-root color: `#rrggbb` (opaque base) or `#rrggbbaa`
 * (translucent tint — VS Code's diffEditor value format), with the CSS
 * shorthands `#rgb` / `#rgba` (TinyColor expands them). Everything else
 * returns null.
 *
 * @param hex - The hex string.
 * @returns The parsed root color, or null.
 */
export function parseRootColor(hex: string): RootColor | null {
  const parsed = parseHexForm(hex);
  return parsed ? { rgb: parsed.rgb, alpha: parsed.alpha } : null;
}

/**
 * Blend two colors linearly in RGB space (TinyColor's `mix`).
 *
 * @param base - The color to blend into.
 * @param accent - The color being blended in.
 * @param intensity - Blend factor in [0, 1] (0 = base, 1 = accent).
 * @returns The blended RGB.
 */
export function mixRgb(base: RgbColor, accent: RgbColor, intensity: number): RgbColor {
  const blended = new TinyColor(base).mix(new TinyColor(accent), intensity * 100).toRgb();
  return { r: blended.r, g: blended.g, b: blended.b };
}

/**
 * WCAG relative luminance (pi's own terminal-background detection uses the
 * same formula). >= 0.5 reads as a light surface.
 *
 * @param rgb - The color to measure.
 * @returns Relative luminance in [0, 1].
 */
export function rgbLuminance(rgb: RgbColor): number {
  return new TinyColor(rgb).getLuminance();
}

/**
 * Whether the RGB reads as a light surface. WCAG luminance >= 0.5 — pi's own
 * threshold — NOT TinyColor's `isLight()` (that one is perceived brightness
 * (299r+587g+114b)/1000 >= 128, which classifies mid-gray as light; the
 * palettes need the WCAG reading).
 *
 * @param rgb - The color to classify.
 * @returns True when the surface reads as light.
 */
export function isLightRgb(rgb: RgbColor): boolean {
  return rgbLuminance(rgb) >= 0.5;
}

/**
 * The WCAG contrast ratio between two colors (TinyColor's `readability`,
 * bit-identical to the spec formulas; ADR 0001 records the library choice).
 *
 * @param a - One color.
 * @param b - The other color.
 * @returns The contrast ratio (>= 1).
 */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  return readability(new TinyColor(a), new TinyColor(b));
}
