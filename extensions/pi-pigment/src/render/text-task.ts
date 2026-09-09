/**
 * The async preview-task protocol: diffs render through a task object attached
 * to a Text component (placeholder → async render → invalidate), so previews
 * never block the TUI. `getWidthAwareText` wraps a Text so its render(width)
 * drives the task with the real terminal width (sidebar-aware).
 */

import type { Component } from "@earendil-works/pi-tui";

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import type { ParsedDiff } from "#src/core/diff.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

import { clearToolHeaderBg, padDiffBody } from "./header.ts";
import { shouldUseSplit, type DiffViewOptions } from "./render-shared.ts";
import { renderSplit } from "./render-split.ts";
import { renderUnified } from "./render-unified.ts";
import { termW } from "./term.ts";
import { taskKeyOf } from "./tool-output.ts";

/**
 * The async preview task attached to a Text component — the swap
 * protocol's payload. The key identifies a render result; most tasks are
 * width-sensitive (a resize produces a fresh key and a fresh render), but
 * the protocol itself only compares keys — a task whose output has no
 * width-dependent layout (grep's highlighted output) keys on content
 * instead and ignores the width parameter.
 */
export interface PreviewTask {
  /**
   * The width-neutral input stamp — everything the render closure reads
   * that can change between frames, EXCEPT the width (see taskKeyOf).
   * The attach guard compares it: re-attaching a task with the same
   * identity leaves the rendered frame alone (the placeholder overwrite
   * and task restart the wrapper-side errorFrameKey/newFileKey guards
   * used to prevent, folded into the protocol's single home).
   */
  identity: string;
  /** Text shown synchronously while the async render is in flight. */
  placeholder: string;
  /** Text shown when the async render fails. */
  fallback: string;
  /** Asks the TUI to redraw this component. */
  invalidate: () => void;
  /** Cache key for the rendered result; receives the render width. */
  key: (width: number) => string;
  /** Produces the final rendered output at a given width. */
  render: (width: number) => Promise<string>;
}

/**
 * The grammar-state seed source for a diff render: given the first visible
 * hunk's start line (new-file numbering), return the file text BEFORE it
 * (the caller owns where the file content lives — write has it in args,
 * edit reads the post-edit file from disk). Returning undefined renders
 * unseeded (the pre-fix behavior — embedded grammars color from the top
 * level).
 */
export type DiffSeedFor = (hunkNewStart: number) => string | undefined;

/**
 * The latest-wins render queue hanging off a preview host: at most one
 * render runs at a time; every newer request overwrites `pendingWidth`
 * so a burst collapses to ≤2 renders (the in-flight one + the newest).
 * The frame loop enqueues, `drainPreview` executes one at a time.
 */
export interface PreviewRenderQueue {
  /** True while a render runs for this host. */
  inFlight: boolean;
  /** The newest requested width not yet started (undefined = queue empty). */
  pendingWidth?: number;
}

/** Extended Text component carrying a preview task. */
export interface PreviewTextHost extends Component {
  /** Replaces the component's rendered text. */
  setText(text: string): void;
  /** Marks the component as already wrapped (idempotence guard). */
  previewWidthAware?: boolean;
  /** The component's original render, saved before wrapping. */
  previewBaseRender?: (width: number) => string[];
  /**
   * The key of the last scheduled/committed render — the commit guard AND
   * the frame loop's dedupe: a same-key frame re-renders nothing, and an
   * async result whose key was superseded never touches the text. Reset
   * by the attach guard on identity change and by clearPreviewTask, so a
   * re-armed or re-attached host always re-renders on its next frame.
   */
  previewRenderedKey?: string;
  /** The scheduled preview task driving this component. */
  previewTask?: PreviewTask;
  /**
   * The attached task's width-neutral identity — the attach guard's
   * stamp (same inputs → no placeholder write, no redraw, no restart).
   * Declared and consumed here (the protocol's own compare; the old
   * wrapper-side errorFrameKey lived in the factory instead).
   */
  previewIdentity?: string;
  /** The latest-wins render queue (created by the first enqueue). */
  previewRender?: PreviewRenderQueue;
  /** Per-line background painter the TUI calls while rendering; undefined = none. */
  customBgFn?: (line: string) => string;
  /** Sets the background painter (CustomBgText's official entry). */
  setCustomBgFn(fn?: (line: string) => string): void;
}

/** A Text component factory (the pi-tui Text class, injected for testability). */
export type TextComponentFactory = new (text: string, x: number, y: number) => Component;

/**
 * Clear the preview task and render the text empty — the shared
 * "nothing to show" exit every output wrapper's empty guard uses.
 *
 * @param text - The Text component.
 * @returns The component (for a direct return).
 */
export function renderEmpty(text: PreviewTextHost): PreviewTextHost {
  clearPreviewTask(text);
  text.setText("");
  return text;
}

/**
 * Detach the live task AND the whole render protocol state (identity,
 * rendered key, queue). The synchronous render paths (renderEmpty, the
 * plain fallback) must call this — leaving ANY of it behind would either
 * make a later same-identity task skip its re-arm on a host that no
 * longer carries the old task's content, or skip its render because the
 * cleared key still matches (a stuck placeholder).
 *
 * @param text - The host.
 */
export function clearPreviewTask(text: PreviewTextHost): void {
  text.previewTask = undefined;
  text.previewIdentity = undefined;
  text.previewRenderedKey = undefined;
  text.previewRender = undefined;
}

/**
 * Attach a width-aware preview task to a Text component (the primitive setDiffPreviewTask builds
 * on) — the protocol's OWN re-arm guard: the TUI's updateDisplay re-runs renderResult and
 * re-attaches a fresh task closure every cycle, and only a CHANGED identity re-arms (placeholder +
 * full protocol reset — the rendered key and queue belong to the old task generation); unchanged
 * re-runs keep the rendered frame. The render loop's width-aware key stays the
 * width guard — two orthogonal compares, both inside the protocol. Never invalidates — the async
 * render completes through the loop's own completion path (pinned in
 * tests/render/text-task.test.ts).
 *
 * @param text - The Text component.
 * @param task - The preview task.
 */
export function attachPreviewTask(text: PreviewTextHost, task: PreviewTask): void {
  text.previewTask = task;
  if (text.previewIdentity === task.identity) return;
  text.previewIdentity = task.identity;
  text.previewRenderedKey = undefined;
  text.previewRender = undefined;
  text.setText(task.placeholder);
}

/** The diff preview's inputs — one object (the positional form drifted to ten). */
export interface DiffPreviewInput {
  /** The host Text component to attach the task to. */
  text: PreviewTextHost;
  /** Cache-key prefix distinguishing preview kinds ("ed", "wd"). */
  keyPrefix: string;
  /** The parsed diff to render. */
  diff: ParsedDiff;
  /** The Shiki language for highlighting. */
  language: BundledLanguage | undefined;
  /** Row budget for the visible window. */
  maxLines: number;
  /** The resolved palette the views render with (its identity keys the cache). */
  palette: DiffPalette;
  /** The active pi theme (the views' syntax source). */
  theme: PaletteTheme;
  /** The render context (invalidate callback). */
  ctx: Pick<PreviewTask, "invalidate">;
  /** Configured change-indicator style. */
  indicatorStyle: IndicatorStyle;
  /** Optional grammar-state seed source (embedded grammars). */
  seedFor?: DiffSeedFor;
}

/**
 * Attach the diff preview task described by `input` to its host Text.
 *
 * @param input - The preview's inputs (see DiffPreviewInput).
 */
export function setDiffPreviewTask(input: DiffPreviewInput): void {
  const {
    text,
    keyPrefix,
    diff,
    language,
    maxLines,
    palette,
    theme,
    ctx,
    indicatorStyle,
    seedFor,
  } = input;
  clearToolHeaderBg(text);
  // ONE identity, width-appended at render time: everything else is
  // frozen per task (the diff, the palette identity — composing it once
  // skips the per-render themeCacheKey walk anyway).
  const baseKey = taskKeyOf(keyPrefix, [palette.identity, diff.lines.length, language ?? ""]);
  attachPreviewTask(text, {
    identity: baseKey,
    placeholder: theme.fg("muted", " rendering diff…"),
    fallback: "",
    invalidate: ctx.invalidate,
    key: (width: number) => `${baseKey}\u0000${width}`,
    render: async (width: number) => {
      // The seed (embedded-grammar coloring) stays OUT of the
      // task key: the diff's content is frozen, and a later edit to the
      // file (edit's seed source is the disk) must not re-color history —
      // the seed only keys the highlight cache. Residual, accepted: a
      // width change re-renders and re-reads the seed, so a file edited
      // after the fact colors the frozen hunk with the new prefix (a
      // rare, display-only approximation).
      // The budget follows the chosen view: split pairs a del+add into ONE
      // visual row, so its window can consume up to 2×maxLines logical
      // lines — slicing the seed at maxLines alone would leave the deepest
      // visible hunk uncovered (the vue bug's second face, split edition).
      const seedBudget = shouldUseSplit(diff, width, maxLines) ? maxLines * 2 : maxLines;
      const seed = seedFor ? seedFor(lastHunkNewStart(diff, seedBudget)) : undefined;
      return renderPaddedDiff({
        diff,
        language,
        maxLines,
        width,
        palette,
        theme,
        indicatorStyle,
        seed,
      });
    },
  });
}

/**
 * Render the diff view — split when the geometry admits it, unified
 * otherwise — padded to the body indent. The view choice lives here (one
 * owner beside the fallback it drives), not in the views or the callers.
 *
 * @param options - The frame inputs.
 * @returns The rendered view.
 */
async function renderPaddedDiff(
  options: Omit<DiffViewOptions, "piTheme" | "indicator"> & {
    theme: PaletteTheme;
    indicatorStyle: IndicatorStyle;
  },
): Promise<string> {
  const { diff, language, maxLines, width, palette, theme, indicatorStyle, seed } = options;
  // One frame for both views: the split-vs-unified choice picks the
  // renderer, never the inputs (DiffViewOptions).
  const view = {
    diff,
    language,
    maxLines,
    width,
    palette,
    piTheme: theme,
    indicator: indicatorStyle,
    seed,
  };
  const body = await (shouldUseSplit(diff, width, maxLines) ? renderSplit : renderUnified)(view);
  return padDiffBody(body, palette);
}

/**
 * The LAST visible hunk's start line in new-file numbering (1-based) —
 * the slice point the seed must cover up to. The seed re-enters the
 * grammar stack at that point, so it must span EVERY visible hunk: a
 * multi-hunk diff whose first hunk sits in the template would otherwise
 * leave a later script hunk below the seed coverage — uncolored (the
 * "vue partial diff renders uncolored" report's second face).
 *
 * @param diff - The parsed diff.
 * @param maxLines - The visible window's row budget.
 * @returns The deepest visible hunk's new-file start line, or 1 when the
 *   diff carries no hunk headers (the programmatic parseDiff path).
 */
function lastHunkNewStart(diff: ParsedDiff, maxLines: number): number {
  // Parser invariant this leans on: both producers (parseDiff,
  // parsePatchFiles) open non-empty diffs with sep lines carrying
  // hunkMeta. Track the LAST sep line's start over the visible window;
  // the newNum fallback and the terminal 1 exist for that contract, not
  // for this caller's call sites.
  let last = 0;
  for (const line of diff.lines.slice(0, maxLines)) {
    if (line.hunkMeta?.newStart) last = line.hunkMeta.newStart;
    else if (last === 0 && line.newNum !== null) last = line.newNum;
  }
  return last >= 1 ? last : 1;
}

/**
 * Wrap a Text component so render(width) drives the attached preview task:
 * on key change it shows the placeholder, kicks the async render, and
 * swaps in the result (or the fallback on failure).
 *
 * @param lastComponent - The component to wrap (a fresh Text when undefined).
 * @param textFactory - The pi-tui Text class.
 * @returns The width-aware component.
 */
export function getWidthAwareText(
  lastComponent: Component | undefined,
  textFactory: TextComponentFactory,
): PreviewTextHost {
  // The last component is a Text host in every flow we create — EXCEPT the
  // shell tools' error path: the delegated SDK renderer owns the slot for
  // partial frames (a Container, no setText), and the error frame that
  // replaces it must not call setText on it (the TypeError used to sink the
  // whole frame to the TUI's plain fallback). A non-Text host means the
  // slot belongs to someone else: take a fresh Text instead.
  const reusable =
    lastComponent !== undefined && typeof (lastComponent as PreviewTextHost).setText === "function";
  const text = (reusable ? lastComponent : new textFactory("", 0, 0)) as PreviewTextHost;
  if (text.previewWidthAware) return text;
  const baseRender = typeof text.render === "function" ? text.render.bind(text) : null;
  if (!baseRender) return text;
  text.previewWidthAware = true;
  text.previewBaseRender = baseRender as (width: number) => string[];
  text.render = (width: number) => {
    const task = text.previewTask;

    if (task) {
      const renderWidth = Math.max(1, Math.floor(width || termW()));
      const key = task.key(renderWidth);
      if (text.previewRenderedKey !== key) {
        text.previewRenderedKey = key;
        text.setText(task.placeholder);
        // Latest-wins queue: enqueue the newest width and drain. A render
        // already running stays the only one — newer frames overwrite the
        // pending width, so a burst (drag-resize, streaming partials)
        // collapses to at most two renders: the in-flight one plus the
        // newest. Superseded results never commit (the key guard).
        const queue = (text.previewRender ??= { inFlight: false });
        queue.pendingWidth = renderWidth;
        void drainPreview(text);
      }
    }
    return text.previewBaseRender?.(width) ?? [];
  };
  return text;
}

/**
 * Drain a host's latest-wins queue: run renders one at a time until no
 * pending width remains. Each iteration re-reads the CURRENT task (a
 * mid-flight re-attach pulls the next generation's render), guards the
 * commit on the key recorded at start (a superseded result neither swaps
 * nor falls back), and loops for the newest width that arrived while it
 * ran.
 *
 * @param text - The host carrying the queue.
 */
async function drainPreview(text: PreviewTextHost): Promise<void> {
  const queue = text.previewRender;
  if (!queue) return;
  while (!queue.inFlight && queue.pendingWidth !== undefined) {
    const task = text.previewTask;
    if (!task) return; // detached mid-queue: the clear wiped the state
    const width = queue.pendingWidth;
    queue.pendingWidth = undefined;
    queue.inFlight = true;
    const key = task.key(width);
    let rendered: string;
    try {
      rendered = await task.render(width);
    } catch {
      rendered = task.fallback;
    }
    queue.inFlight = false;
    if (text.previewRenderedKey === key) {
      text.setText(rendered);
      task.invalidate();
    }
  }
}
