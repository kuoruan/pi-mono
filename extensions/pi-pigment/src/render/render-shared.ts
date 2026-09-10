/**
 * The view contract both diff views share: the input frame
 * (`DiffViewOptions`), the minimum render width, and the one highlight
 * choke point (`highlightPairSides`) where both views' visible-window
 * sources become highlighted (or don't). The layout authorities the views
 * consume live in their own modules: wrap.ts (wrapping), row-frame.ts
 * (gutter composition), word-diff.ts (word-level emphasis), inject-bg.ts
 * (backgrounds), split-verdict.ts (the split/unified choice).
 */

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import type { ParsedDiff } from "#src/core/diff.ts";
import { hlBlock, MAX_HL_CHARS } from "#src/theme/highlight.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

/** The inputs both diff views share (split and unified take one frame). */
export interface DiffViewOptions {
  /** The parsed diff. */
  diff: ParsedDiff;
  /** Shiki language for highlighting (undefined skips it). */
  language: BundledLanguage | undefined;
  /** Row budget for the visible window. */
  maxLines: number;
  /** Render width in columns (the views clamp to MIN_RENDER_WIDTH). */
  width: number;
  /** The resolved palette (all diff colors). */
  palette: DiffPalette;
  /** The active pi theme (syntax highlighting source). */
  piTheme?: PaletteTheme;
  /**
   * Left-edge change indicator style (config: indicatorStyle) — the
   * caller's configured style, always explicit (no default: the config
   * owns it).
   */
  indicator: IndicatorStyle;
  /**
   * Grammar-state seed for embedded grammars (vue/html): the file text
   * before the first visible hunk. A diff slice has no `<script>` tag in
   * view, so tokenizing from the grammar's top level leaves script lines
   * uncolored; the seed re-enters the TextMate stack at the slice point.
   */
  seed?: string;
}

/** Renders below this width fall back to the unified view (split needs two code columns). */
export const MIN_RENDER_WIDTH = 40;

/** The highlightPairSides inputs. */
export interface HighlightSidesOptions {
  /** Old-side source lines. */
  oldSource: string[];
  /** New-side source lines. */
  newSource: string[];
  /** The language (undefined = plain pass-through). */
  language: BundledLanguage | undefined;
  /** The resolved palette (hlBlock's theme input). */
  palette: DiffPalette;
  /** The pi theme behind it. */
  piTheme: PaletteTheme | undefined;
  /** The grammar-state seed (embedded grammars). */
  seed?: string;
}

/**
 * Highlight both sides of a diff view: one hlBlock per side, in parallel,
 * gated on the combined character budget (above MAX_HL_CHARS the sources
 * pass through unstyled — the same fallback the large-diff path uses).
 * Both views collect their visible window's sources first; this is the
 * one choke point where those sources become highlighted (or don't).
 *
 * @param options - The sides to highlight.
 * @returns The [old, new] line arrays (highlighted or passed through) and
 *   whether highlighting ran — the views freeze their cursors when it
 *   did not (the plain-text paths consume nothing).
 */
export async function highlightPairSides(
  options: HighlightSidesOptions,
): Promise<{ sides: [string[], string[]]; highlighted: boolean }> {
  const { oldSource, newSource, language, palette, piTheme, seed } = options;
  // Gate on what will actually be highlighted (the visible window's
  // sources), not the whole files — a large file with a small edit still
  // highlights.
  const sourceChars =
    oldSource.reduce((n, line) => n + line.length, 0) +
    newSource.reduce((n, line) => n + line.length, 0);
  if (sourceChars > MAX_HL_CHARS) return { sides: [oldSource, newSource], highlighted: false };
  const sides = await Promise.all([
    hlBlock({
      code: oldSource.join("\n"),
      language,
      palette,
      piTheme,
      seed,
    }),
    hlBlock({
      code: newSource.join("\n"),
      language,
      palette,
      piTheme,
      seed,
    }),
  ]);
  return { sides, highlighted: true };
}
