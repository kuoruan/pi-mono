/**
 * The tool-wrapper factory: one place owns the skeleton every wrapper shares
 * — execute delegation, the error frame, text extraction, and lastComponent
 * acquisition — so each tool module shrinks to its genuinely varying render
 * logic. `this`-safety: the SDK originals are always invoked with
 * method-call syntax (`orig.renderCall?.(...)`) so any internal receiver
 * binding survives.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { inertText } from "#src/core/ansi.ts";
import { createBoundedMap } from "#src/core/bounded-map.ts";
import { resolveDiffPalette, type DiffPalette, type PaletteTheme } from "#src/theme/palette.ts";

import { ERROR_FRAME_DEFAULT_WIDTH, formatToolErrorResult, setToolErrorBg } from "./error-frame.ts";
import { clearToolHeaderBg, resultLine } from "./header.ts";
import {
  attachPreviewTask,
  clearPreviewTask,
  definePreviewTask,
  getWidthAwareText,
  type PreviewTextHost,
} from "./text-task.ts";
import { elapsedOf, firstTextOf, stampElapsed, tookFooter } from "./tool-output.ts";
import {
  type ShellState,
  callStateOf,
  type RenderContext,
  type ToolServices,
} from "./tool-services.ts";

/**
 * A renderResult implementation the factory calls with extracted text. The
 * theme arrives as PaletteTheme (the render vocabulary — the SDK's Theme class is
 * structurally assignable, so wrappers never cast).
 */
export type RenderResultBody<TState extends object> = (args: {
  text: PreviewTextHost;
  /** The resolved palette (one walk per renderResult, shared with the error frame). */
  palette: DiffPalette;
  theme: PaletteTheme;
  ctx: RenderContext<TState>;
  /** The raw SDK result (details carry the execute-side payload). */
  result: AgentToolResult<unknown>;
  /** The render options (expanded, isPartial). */
  options: ToolRenderResultOptions;
  /**
   * The wrapped SDK tool's own renderResult — for wrappers that delegate
   * output rendering wholesale (bash: the command is ours, the output is
   * the SDK's native display).
   */
  origRenderResult: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: PaletteTheme,
    ctx: RenderContext<TState>,
  ) => Component;
}) => Component;

/** A renderCall implementation the factory calls. */
export type RenderCallBody<TState extends object> = (args: {
  text: PreviewTextHost;
  theme: PaletteTheme;
  ctx: RenderContext<TState>;
  /** The raw render args (may be partial while streaming). */
  renderArgs: unknown;
}) => Component;

/** The wrapper's per-tool configuration. */
export interface WrapperSpec<TState extends object> {
  /** The renderCall body (undefined delegates to the SDK original). */
  renderCall?: RenderCallBody<TState>;
  /** The renderResult body (the factory handles the error frame around it). */
  renderResult?: RenderResultBody<TState>;
  /** A custom execute (write/edit stash diffs into details). */
  execute?: (
    tid: string,
    params: unknown,
    sig: AbortSignal | undefined,
    upd: AgentToolUpdateCallback<unknown> | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
  /**
   * Cleanup before the factory's error frame renders — for wrappers whose
   * delegated SDK renderer owns resources that its own (bypassed)
   * renderResult would have released (the shell tools' timing interval).
   */
  onError?: (ctx: RenderContext<TState>) => void;
  /**
   * Which TUI shell frames this tool's renders (ToolDefinition.renderShell):
   *
   * - "default": the TUI wraps the tool's components in the standard content Box (padding 1,1) whose
   *   bgFn paints the call-state background across EVERY row — success bg for live/succeeded
   *   frames, ERROR bg for failed ones, the frame's blank rows and footers included. Tools render
   *   plain Text/Container pieces and inherit the frame;
   * - "self": the tool renders its own framing — the TUI outlets the components' rows BARE (no Box
   *   background, no padding). A self tool must paint every background itself (the native edit tool
   *   does this: its call component is its own Box with a bgFn it flips per call state).
   *
   * Every wrapper declares "default" EXPLICITLY: the factory spreads
   * the SDK origin's definition first, and an inherited "self" would
   * silently strip the frame background from our plain-Text renders
   * (the edit error-frame bug this field fixes). Pin the contract
   * instead of inheriting it.
   */
  renderShell?: "default" | "self";
}

/**
 * The plain-text fallback for unknown details: clear any stale task and
 * header background, render the result's first text dimmed. Write/edit
 * renderResults share it as their terminal branch.
 *
 * @param text - The text component.
 * @param theme - The pi theme.
 * @param result - The raw tool result.
 * @returns The component.
 */
export function renderPlainTextFallback(
  text: PreviewTextHost,
  theme: PaletteTheme,
  result: AgentToolResult<unknown>,
): Component {
  // Clear BOTH the task and its identity stamp — a later task with the
  // same inputs must re-arm on a host this fallback just bypassed.
  clearPreviewTask(text);
  clearToolHeaderBg(text);
  // Inert at intake (ADR 0004): the result text embeds paths and tool
  // output (e.g. "Successfully wrote N bytes to <path>"). A flat 120
  // code-point window (newlines survive — the Text component renders
  // them), code points so a surrogate pair never splits mid-sequence.
  const safe = inertText(firstTextOf(result));
  text.setText(resultLine(theme.fg("dim", Array.from(safe).slice(0, 120).join(""))));
  return text;
}

/**
 * Elapsed times of THROWN executions, keyed by tool call id: a throw
 * never reaches stampElapsed (the agent loop builds a fresh `details: {}`
 * around the message), so the error frame's Took footer reads here. Bounded
 * like its sibling memos; entries die on read (each id renders once).
 */
const thrownElapsed = createBoundedMap<string, number>(64);

/**
 * The error frame's Took MILLISECONDS, memoized per call id: the TUI's
 * updateDisplay re-runs renderResult for the same error repeatedly, and the
 * first render consumes the thrown record — a re-run recomputing took from
 * the (now-deleted) record yielded "" and a changed frameKey, which re-armed
 * the task and dropped the Took footer from every later frame. The memo
 * holds the resolved milliseconds; tookFooter re-renders per theme, so a
 * theme switch recolors the footer through the regular key change.
 */
const errorTookMs = createBoundedMap<string, number | undefined>(64);

/**
 * Resolve the error frame's Took milliseconds, once per tool call: the
 * result's stamped sideband when the tool RETURNED an error result, the
 * thrown-span record when it threw (read-once — consumed here and
 * memoized so re-runs stay stable). An UNMEASURED memo value (undefined)
 * re-resolves on every re-run — idempotent and cheap (both sources are
 * already gone), so the map's missing-vs-undefined distinction needs no
 * extra bookkeeping.
 *
 * @param toolCallId - The tool call's id (the memo key).
 * @param result - The errored result (its details may stamp elapsed).
 * @returns The elapsed milliseconds, or undefined when unmeasurable.
 */
function resolveErrorTookMs(
  toolCallId: string,
  result: AgentToolResult<unknown>,
): number | undefined {
  const memo = errorTookMs.get(toolCallId);
  if (memo !== undefined) return memo;
  const thrown = thrownElapsed.get(toolCallId);
  thrownElapsed.delete(toolCallId);
  const ms = elapsedOf(result) ?? thrown;
  errorTookMs.set(toolCallId, ms);
  return ms;
}

/**
 * Build a tool wrapper around `orig`: the factory owns the skeleton, the
 * spec supplies the per-tool variance. `TState` types the wrapper's render
 * state — the runtime shape is the TUI's `{}` either way; the generic only
 * tightens what the spec bodies may read and write.
 *
 * @param orig - The SDK tool to wrap.
 * @param services - Assembly services (text factory).
 * @param spec - The per-tool render bodies.
 * @returns The wrapped tool.
 */
export function createToolWrapper<TState extends object = Record<string, unknown>>(
  orig: ToolDefinition,
  services: ToolServices,
  spec: WrapperSpec<TState>,
): ToolDefinition {
  const { textFactory } = services;

  return {
    ...orig,
    // Override the SDK origin's shell claim when the spec prescribes one
    // (edit: "self" → "default" so the Box owns the frame's background).
    ...(spec.renderShell !== undefined ? { renderShell: spec.renderShell } : {}),

    // Delegation verbatim unless the spec owns the execute (write/edit),
    // timed: the elapsed-ms sideband in details is what the grep/find/ls
    // result footers read (bash's native renderer shows its own timing).
    async execute(
      tid: string,
      params: unknown,
      sig: AbortSignal | undefined,
      upd: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const start = performance.now();
      let result: AgentToolResult<unknown>;
      try {
        result = spec.execute
          ? await spec.execute(tid, params, sig, upd, ctx)
          : await orig.execute(tid, params as never, sig, upd, ctx);
      } catch (err) {
        // The error frame owns this call's final render — record the span
        // it cannot otherwise see (the thrown path's details are fresh).
        thrownElapsed.set(tid, performance.now() - start);
        throw err;
      }
      if (result) stampElapsed(result, performance.now() - start);
      return result;
    },

    renderCall(args: unknown, theme: Theme, ctx: RenderContext<TState>): Component {
      const text = getWidthAwareText(ctx.lastComponent, textFactory);
      if (spec.renderCall) return spec.renderCall({ text, theme, ctx, renderArgs: args });
      return orig.renderCall?.(args, theme, ctx as never) ?? text;
    },

    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      ctx: RenderContext<TState>,
    ): Component {
      const text = getWidthAwareText(ctx.lastComponent, textFactory);
      const palette = resolveDiffPalette(theme);
      const status = callStateOf(ctx);
      // Every FINAL frame sweeps the streaming interval: the native shell
      // renderer arms it while partial output streams and clears it only
      // on the frames it renders itself — the error frame below bypasses
      // that render, and a success path that replaces the renderer (the
      // edit/write previews) must not depend on it either. Pending frames
      // keep their ticking timer (that live invalidate IS the display).
      if (status !== "pending") {
        const state = ctx.state as Pick<ShellState, "interval"> | undefined;
        if (state?.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      if (status === "error") {
        // Tool-specific cleanup (the shell tools' SDK renderer would have
        // released its own resources in the final render we bypass).
        spec.onError?.(ctx);
        const message = firstTextOf(result) || "Error";
        // The Took footer the bypassed native renderer would have shown:
        // the result's sideband when the tool RETURNED an error result,
        // the thrown-span record when it threw (read-once — consumed by
        // the first render, then memoized below so re-runs stay stable).
        const tookMs = resolveErrorTookMs(ctx.toolCallId, result);
        const took = tookMs !== undefined ? tookFooter(tookMs, theme) : "";
        // ONE builder drives both the synchronous placeholder and the
        // width-aware preview task: the task re-renders at the TUI's real
        // width so every wrapped visual row carries the bar column.
        const frame = (width: number): string =>
          formatToolErrorResult({
            name: orig.name,
            message,
            theme,
            pathShortener: services.shortPath,
            expanded: options.expanded,
            indicatorStyle: services.indicatorStyle,
            took,
            width,
          });
        // The attach guard (previewIdentity compare) replaces the old
        // errorFrameKey branch: unchanged re-runs keep the rendered
        // frame; expand, theme swaps, or a new message change the
        // identity and re-arm through the protocol.
        const placeholder = frame(ERROR_FRAME_DEFAULT_WIDTH);
        setToolErrorBg(text, theme, palette);
        attachPreviewTask(
          text,
          definePreviewTask({
            prefix: orig.name,
            stamps: [options.expanded ? 1 : 0, took, palette.identity, message],
            widthAware: true,
            placeholder,
            fallback: placeholder,
            invalidate: ctx.invalidate,
            render: (w: number) => Promise.resolve(frame(w)),
          }),
        );
        return text;
      }
      if (spec.renderResult) {
        return spec.renderResult({
          text,
          palette,
          theme,
          ctx,
          result,
          options,
          origRenderResult: (res, opts, th, ctx2) =>
            orig.renderResult?.(res, opts, th as Theme, ctx2 as never) ?? text,
        });
      }
      return orig.renderResult?.(result, options, theme, ctx as never) ?? text;
    },
  };
}
