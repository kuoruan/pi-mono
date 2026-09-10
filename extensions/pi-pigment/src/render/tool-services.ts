/**
 * Shared tool-wrapper types: the services the assembly injects into the
 * wrappers, the render context the TUI hands to renderers, and the
 * per-tool render states.
 */

import type { Component } from "@earendil-works/pi-tui";

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import type { ParsedDiff } from "#src/core/diff.ts";

import type { TextComponentFactory } from "./text-task.ts";

/**
 * The render context the TUI passes to renderCall/renderResult — the SDK's
 * ToolRenderContext, hand-projected: the type exists upstream
 * (dist/core/extensions/types.d.ts, where 0.85.0 introduced it) but is
 * not re-exported from the package root on 0.85.1, and the exports map
 * blocks the deep path — re-derive from it (Omit expanded/showImages)
 * once a version exports it at the root. `TState` is the wrapper's own
 * render state: the TUI initializes it as `{}` and the wrapper's fields
 * populate lazily, so every state field is optional by contract.
 */
export interface RenderContext<TState extends object = Record<string, unknown>> {
  /** Current tool call arguments. */
  args: unknown;
  /**
   * Unique id for this tool execution (stable across call/result renders — the thrown-error timing
   * key).
   */
  toolCallId: string;
  /** Invalidate just this tool execution component for redraw. */
  invalidate: () => void;
  /** Previously returned component for this render slot, if any. */
  lastComponent: Component | undefined;
  /** Shared renderer state for this tool row (the wrapper's own shape). */
  state: TState;
  /** Whether the tool call arguments are complete. */
  argsComplete: boolean;
  /** Whether the result is partial/streaming (false once final, and on session restore). */
  isPartial: boolean;
  /** Whether the current result is an error. */
  isError: boolean;
  /** Whether the tool execution has started (the TUI sets it on execute). */
  executionStarted: boolean;
  /** The session working directory (path resolution for display links). */
  cwd: string;
}

/**
 * Read a render slot's arguments as a partial tool input — the one cast
 * helper for the `(args ?? {}) as Partial<X>` idiom every wrapper opens
 * with (args is `unknown` at the boundary; the wrapper knows its shape).
 *
 * @param args - The raw render args (ctx.args or renderArgs).
 * @returns The partial input view.
 */
export function argsOf<T extends object>(args: unknown): Partial<T> {
  return (args ?? {}) as Partial<T>;
}

/**
 * Whether the call's arguments can no longer grow. Live, this is
 * argsComplete (the TUI sets it when the streamed args JSON closes);
 * restored sessions never get that mark — but their final result (isPartial
 * false) means the same thing. One concept, two arrival paths.
 *
 * @param ctx - The render context.
 * @returns True when the arguments are settled.
 */
export function argsSettled(ctx: RenderContext<object>): boolean {
  return ctx.argsComplete || !ctx.isPartial;
}

/**
 * The call's three-state outcome every frame consumes — derived from the
 * SDK projection's two booleans (error wins over pending).
 */
export type CallState = "pending" | "success" | "error";

/**
 * Derive the call's outcome state: the single home for the error/pending
 * precedence, so frame painters speak the three-state model instead of
 * combining booleans per site.
 *
 * @param ctx - The render context.
 * @returns The call's outcome state.
 */
export function callStateOf(ctx: RenderContext<object>): CallState {
  return ctx.isError ? "error" : ctx.isPartial ? "pending" : "success";
}

/**
 * Whether the call's result may still grow: the preview frames' streaming
 * gate, derived from the three-state model. Only PENDING calls stream;
 * error frames never reach the result previews (the factory intercepts
 * them), so pending and result growth coincide everywhere previews render.
 *
 * @param ctx - The render context.
 * @returns True while the result's content is still streaming.
 */
export function resultStreaming(ctx: RenderContext<object>): boolean {
  return callStateOf(ctx) === "pending";
}

/**
 * The shell tools' render state. Co-authored with the SDK: our renderCall
 * stashes the command fields, and the SDK's native bash/powershell
 * renderResult (which the wrapper delegates output rendering to) reads
 * startedAt and writes startedAt/endedAt/interval for its timing display —
 * this type is the contract both sides write into.
 */
export interface ShellState {
  /** The command string (stashed by renderCall). */
  command?: string;
  /** The command + theme identity the highlighted form was computed for (staleness). */
  commandHighlightFor?: string;
  /** The shell-grammar highlighted command (swapped in by renderCall). */
  commandHighlight?: string;
  /** Execution start (the SDK result renderer's timing display). */
  startedAt?: number;
  /** Execution end (the SDK result renderer's timing display). */
  endedAt?: number;
  /**
   * The native result renderer's elapsed-time interval — it re-renders
   * every second while a partial result streams, and clears it in its own
   * final render. The factory sweeps it on every FINAL frame (success or
   * error) so no path that replaces that render leaks it.
   */
  interval?: ReturnType<typeof setInterval>;
}

/**
 * The create-preview stats (write's new-file path): the content's line
 * count and fingerprint, keyed by the content REFERENCE — settled args
 * are frozen, so the reference is stable frame to frame and the scans
 * run once per call, not per updateDisplay frame.
 */
export interface NewFileStatsMemo {
  /** The content string the stats were computed from. */
  content: string;
  /** The content's line count (0 for empty). */
  lineCount: number;
  /** The content's FNV-1a fingerprint (the identity key's seal). */
  fingerprint: string;
}

/**
 * Write's render state: the existence-probe cache (renderCall), the
 * create-preview stats memo (renderResult), and the stats stash
 * renderResult bridges from result details (the "+N −M" call-header
 * suffix).
 */
export interface WriteState {
  /** The existence probe cache (per path — renderCall probes sync, once). */
  existsProbes?: Record<string, boolean>;
  /** The create-preview stats memo (see {@link NewFileStatsMemo}). */
  newFileStats?: NewFileStatsMemo;
  /**
   * The +added/−removed counts bridged from result details by
   * renderResult (the call header renders on every update, so it
   * picks these up on the next frame).
   */
  added?: number;
  /** The removed count (see added). */
  removed?: number;
  /** The no-change confirmation (bridged once; the header suffix reads it). */
  noChange?: boolean;
}

/**
 * The parse memo: a frozen patch's ParsedDiff keyed by patch identity
 * (renderResult re-runs per frame; the parse must not).
 */
export interface ParsedDiffMemo {
  /** The patch text the diff was parsed from. */
  patch: string | undefined;
  /** The parsed diff (undefined when the patch had no changes). */
  diff: ParsedDiff | undefined;
}

/**
 * The edit wrapper's per-call render state (bridges execute→renderResult
 * facts into the header suffix and caches the diff parse + the seed's
 * file lines).
 */
export interface EditState {
  /** The edit-operation count (bridged with the diff stats). */
  editCount?: number;
  /**
   * The seed source's lines for embedded grammars: the edited file read
   * once per call (undefined = not read yet, null = unreadable). The row
   * has one path, so the memo needs no key; see the seed producer in
   * tool-edit.ts.
   */
  seedLines?: string[] | null;
  /** The parse memo (identity-keyed; see {@link ParsedDiffMemo}). */
  parsedDiff?: ParsedDiffMemo;
  /** The parsed-diff line count. */
  diffLines?: number;
  /** The added-line count. */
  added?: number;
  /** The removed-line count. */
  removed?: number;
}

/** Services the tool wrappers need from the assembly. */
export interface ToolServices {
  /** Path shortener for headers (relative to cwd, `~` for home). */
  shortPath: (p: string) => string;
  /** Configured left-edge change-indicator style. */
  indicatorStyle: IndicatorStyle;
  /** The pi-tui Text class (for fresh components). */
  textFactory: TextComponentFactory;
}
