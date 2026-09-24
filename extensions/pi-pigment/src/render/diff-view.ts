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
import { MAX_HL_CHARS } from "#src/theme/highlight.ts";
import type { ResolvedTheme } from "#src/theme/scheme.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

import type { RenderView } from "./session.ts";

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
  /**
   * The frame's derived view (the session seam): `scheme` for the row
   * frames and word emphasis, `highlight` for the code blocks. One input
   * — the scheme and the highlighter can never diverge.
   */
  view: RenderView;
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

/**
 * Renders below this width fall back to the unified view (split needs two code columns).
 *
 * NOTE: this is the total RENDER width, not a code pane — do not confuse
 * with FITS_GATE_MIN_WIDTH (44), which gates the wrap fast path on the
 * per-side code width.
 */
export const MIN_RENDER_WIDTH = 40;

/**
 * The "N more lines" tail both diff views close their visible window with.
 * One home for the styled row: the views compute a different N (split
 * counts the hidden logical lines across its paired rows, unified the
 * sliced-off tail of `diff.lines`) but the glyph shape and colors are the
 * same bytes in both.
 *
 * @param hidden - The hidden logical-line count.
 * @param scheme - The resolved diff scheme (the row frame's colors).
 * @returns The styled tail row.
 */
export function hiddenLinesTail(hidden: number, scheme: ResolvedTheme): string {
  return `${scheme.bgBase}${scheme.fgDim}  ... (${hidden} more lines)${scheme.rowReset}`;
}

/** The highlightPairSides inputs. */
export interface HighlightSidesOptions extends Pick<DiffViewOptions, "language" | "view" | "seed"> {
  /** Old-side source lines. */
  oldSource: string[];
  /** New-side source lines. */
  newSource: string[];
}

/** The highlightPairSides product. */
export interface HighlightPairSidesResult {
  /** The [old, new] line arrays (highlighted or passed through). */
  sides: [string[], string[]];
  /** Whether highlighting ran (the views freeze their cursors when it did not). */
  highlighted: boolean;
}

/**
 * Highlight both sides of a diff view: one hlBlock per side, in parallel,
 * gated on the combined character budget (above MAX_HL_CHARS the sources
 * pass through unstyled — the same fallback the large-diff path uses).
 * Both views collect their visible window's sources first; this is the
 * one choke point where those sources become highlighted (or don't).
 *
 * @param options - The sides to highlight.
 * @returns The highlighted (or passed-through) sides.
 */
export async function highlightPairSides(
  options: HighlightSidesOptions,
): Promise<HighlightPairSidesResult> {
  const { oldSource, newSource, language, view, seed } = options;
  // Gate on what will actually be highlighted (the visible window's
  // sources), not the whole files — a large file with a small edit still
  // highlights.
  const sourceChars =
    oldSource.reduce((n, line) => n + line.length, 0) +
    newSource.reduce((n, line) => n + line.length, 0);
  if (sourceChars > MAX_HL_CHARS) return { sides: [oldSource, newSource], highlighted: false };
  const sides = await Promise.all([
    view.highlight({ code: oldSource.join("\n"), language, seed }),
    view.highlight({ code: newSource.join("\n"), language, seed }),
  ]);
  return { sides, highlighted: true };
}
