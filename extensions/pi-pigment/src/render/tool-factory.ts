/**
 * The tool-renderer factory: one place owns the skeleton every renderer
 * shares — the error frame, text extraction, timing, and lastComponent
 * acquisition — so each tool module shrinks to its genuinely varying render
 * logic. `this`-safety: the origin renderers are always invoked with
 * method-call syntax (`orig?.renderCall?.(...)`) so any internal receiver
 * binding survives.
 */

import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { inertText } from "#src/core/ansi.ts";
import type { RenderTheme } from "#src/theme/scheme.ts";

import { renderHeaderLine } from "./ellipsis.ts";
import { ERROR_FRAME_DEFAULT_WIDTH, formatToolErrorResult, setToolErrorBg } from "./error-frame.ts";
import { clearToolHeaderBg, resultLine } from "./header.ts";
import type { FrameView } from "./session.ts";
import {
  attachPreviewTask,
  clearPreviewTask,
  definePreviewTask,
  getWidthAwareText,
  type PreviewTextHost,
} from "./text-task.ts";
import { armTiming, errorFrameKey, firstTextOf, stopTiming } from "./tool-output.ts";
import {
  type ExecutionTimingState,
  callStateOf,
  type RenderContext,
  type ToolServices,
} from "./tool-services.ts";

/**
 * A renderResult implementation the factory calls with extracted text. The
 * frame's view carries the scheme and the pi theme (the render vocabulary:
 * spec bodies never cast — only the `orig` delegation seam coerces the
 * SDK's own Theme class and generic ctx).
 */
export type RenderResultBody<TState extends object> = (args: {
  text: PreviewTextHost;
  /** The frame's derived view: `scheme` + `theme`, and `highlight` (the session seam). */
  view: FrameView;
  ctx: RenderContext<TState>;
  /** The raw SDK result (details carry the execute-side payload). */
  result: AgentToolResult<unknown>;
  /** The render options (expanded, isPartial). */
  options: ToolRenderResultOptions;
  /**
   * The execution duration: pi's recorded `ctx.durationMs` when the host
   * supplies it, else our render-state clock ({@link armTiming}/
   * {@link stopTiming}). Undefined while the result streams, and on a row
   * replayed from the session whose result carried no duration.
   */
  durationMs: number | undefined;
  /**
   * The origin renderers' own renderResult — for renderers that delegate
   * output rendering wholesale (bash: the command is ours, the output is
   * pi's native display).
   */
  origRenderResult: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    ctx: RenderContext<TState>,
  ) => Component;
}) => Component;

/** The call-header line spec: the factory owns the renderHeaderLine skeleton. */
export interface HeaderLineSpec<TState extends object> {
  /** The width-task key prefix (per tool: "gh"/"fh"/"lh"/"rh"). */
  prefix: string;
  /**
   * The styled header body (the byte-parity format*Call formatter). The
   * render args stay unknown at the boundary — the renderer knows its
   * input shape (argsOf); the ctx carries what ls (cwd) and read
   * (cwd + expanded) read into their formatters; the view carries the
   * session's piRoot for read's docs classification.
   */
  formatCallBody: (
    renderArgs: unknown,
    theme: RenderTheme,
    ctx: RenderContext<TState>,
    view: FrameView,
  ) => string;
  /**
   * The pinned status suffix (state that survives truncation — the
   * ellipsis budget never eats it). Undefined = no suffix. Read pins
   * its `:offset-limit` range here; the other headers carry none.
   */
  formatSuffix?: (
    renderArgs: unknown,
    theme: RenderTheme,
    ctx: RenderContext<TState>,
    view: FrameView,
  ) => string;
}

/** A renderCall implementation the factory calls. */
export type RenderCallBody<TState extends object> = (args: {
  text: PreviewTextHost;
  /** The frame's derived view: `scheme` + `theme`, and `highlight` (the session seam). */
  view: FrameView;
  ctx: RenderContext<TState>;
  /** The raw render args (may be partial while streaming). */
  renderArgs: unknown;
}) => Component;

/** The renderer's per-tool configuration. */
export interface RendererSpec<TState extends object> {
  /** The renderCall body (undefined delegates to the SDK original). */
  renderCall?: RenderCallBody<TState>;
  /**
   * A call-header line the factory renders wholesale: the factory owns
   * the renderHeaderLine skeleton (text/prefix/view/ctx/services/body),
   * the spec supplies the key prefix and the body formatter. Takes
   * precedence over renderCall; no renderer sets both.
   */
  renderHeader?: HeaderLineSpec<TState>;
  /** The renderResult body (the factory handles the error frame around it). */
  renderResult?: RenderResultBody<TState>;
  /**
   * Settle a final frame regardless of outcome — for renderers whose
   * delegated SDK renderer owns resources that its own (bypassed)
   * renderResult would have released (the shell tools' timing
   * interval). Runs on every non-pending frame, before any branch
   * renders. Distinct from onError (failure-only, carries the
   * message): settling is outcome-independent and carries nothing.
   */
  onSettled?: (ctx: RenderContext<TState>) => void;
  /**
   * Bridge a failure into render state before the factory's error
   * frame renders (the shell tools' exit-badge parse). Receives the
   * extracted failure message — the same text the frame renders,
   * "Error" when the result carried no text. Failure-only (carries
   * the message); outcome-independent cleanup belongs on onSettled.
   */
  onError?: (ctx: RenderContext<TState>, message: string) => void;
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
   * Every renderer declares "default" EXPLICITLY: the factory spreads
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
  theme: RenderTheme,
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
 * Build a tool's renderer triple around `orig`: the factory owns the
 * skeleton, the spec supplies the per-tool variance. `TState` types the
 * renderer's render state — the runtime shape is the TUI's `{}` either
 * way; the generic only tightens what the spec bodies may read and write.
 *
 * The factory owns NO execution: it returns only the renderer slots, so a
 * caller (the resolver) can hand them to the TUI without touching the
 * tool's definition. The `orig` triple is the delegation target — the
 * renderers `next()` yields (pi's built-in ones when no later resolver
 * overrides them).
 *
 * @param name - The tool name (the error frame's label).
 * @param orig - The renderers this renderer delegates to/falls back to.
 * @param services - Assembly services (text factory).
 * @param spec - The per-tool render bodies.
 * @returns The renderer triple.
 */
export function createToolRenderer<TState extends object = Record<string, unknown>>(
  name: string,
  orig: ToolRenderers | undefined,
  services: ToolServices,
  spec: RendererSpec<TState>,
): ToolRenderers {
  const { textFactory } = services;

  return {
    // Override the SDK origin's shell claim when the spec prescribes one
    // (edit: "self" → "default" so the Box owns the frame's background).
    renderShell: spec.renderShell ?? orig?.renderShell,

    renderCall(args: unknown, theme: Theme, ctx: RenderContext<TState>): Component {
      const text = getWidthAwareText(ctx.lastComponent, textFactory);
      // pi's renderCall timing contract, applied to every renderer: the live
      // execution arms the clock, and a resumed row renders with
      // executionStarted false, so it never gets one.
      armTiming(ctx.state as ExecutionTimingState, ctx.executionStarted);
      if (spec.renderHeader) {
        const view = services.render.forTheme(theme);
        renderHeaderLine({
          text,
          prefix: spec.renderHeader.prefix,
          view,
          ctx,
          services,
          body: spec.renderHeader.formatCallBody(args, view.theme, ctx, view),
          suffix: spec.renderHeader.formatSuffix?.(args, view.theme, ctx, view) ?? "",
        });
        return text;
      }
      if (spec.renderCall)
        return spec.renderCall({
          text,
          view: services.render.forTheme(theme),
          ctx,
          renderArgs: args,
        });
      return orig?.renderCall?.(args, theme, ctx as never) ?? text;
    },

    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      ctx: RenderContext<TState>,
    ): Component {
      const text = getWidthAwareText(ctx.lastComponent, textFactory);
      // The session seam binds this frame's derived state: one object
      // carries the scheme and the resolved token theme, so the two can
      // never diverge inside a frame.
      const view = services.render.forTheme(theme);
      const scheme = view.scheme;
      const status = callStateOf(ctx);
      // Stop the clock before any branch renders: the error frame reads the
      // duration too, and the first settled frame fixes endedAt (repeated
      // renders of one row must read one value — it is part of the frame
      // cache key). stopTiming's side effect (fixing endedAt) is required
      // regardless — the native shell renderer reads the same state fields.
      const measured = stopTiming(
        ctx.state as ExecutionTimingState,
        options.isPartial,
        ctx.isError,
      );
      // Prefer pi's recorded execution duration when the host supplies it
      // (1.1.0 live frames, and replayed rows whose result carried it);
      // fall back to our render-state clock on 1.0.1, on HTML export, and
      // while partial — the places pi leaves `durationMs` undefined.
      const durationMs = ctx.durationMs ?? measured;
      // Every FINAL frame settles renderer resources through the spec
      // hook (the shell timing interval: the native renderer arms it
      // while partial output streams and clears it only on the frames
      // it renders itself — the error frame below bypasses that
      // render, and a success path that replaces the renderer must not
      // depend on it either). Pending frames keep their ticking timer
      // (that live invalidate IS the display). The factory never names
      // the resource — the renderer owns it.
      if (status !== "pending") {
        spec.onSettled?.(ctx);
      }

      if (status === "error") {
        const message = firstTextOf(result) || "Error";
        // Tool-specific cleanup and the failure bridge — the contract
        // lives on RendererSpec.onError.
        spec.onError?.(ctx, message);
        // ONE builder drives both the synchronous placeholder and the
        // width-aware preview task: the task re-renders at the TUI's real
        // width so every wrapped visual row carries the bar column. The
        // frame composes and colors the Took footer itself from durationMs
        // (undefined on a row that never armed the clock — a resumed
        // error row, exactly like pi's own renderers — no footer).
        const frame = (width: number): string =>
          formatToolErrorResult({
            name,
            message,
            theme,
            expanded: options.expanded,
            indicatorStyle: services.indicatorStyle,
            durationMs,
            width,
          });
        // The attach guard (previewIdentity compare) replaces the old
        // errorFrameKey branch: unchanged re-runs keep the rendered
        // frame; expand, theme swaps, a new message, or the measured
        // duration re-arm through the protocol. errorFrameKey owns the
        // stamp list (the -1 elapsed sentinel included).
        const placeholder = frame(ERROR_FRAME_DEFAULT_WIDTH);
        setToolErrorBg(text, theme, scheme);
        attachPreviewTask(
          text,
          definePreviewTask({
            identity: errorFrameKey({
              prefix: name,
              expanded: options.expanded,
              durationMs,
              identity: scheme.identity,
              message,
            }),
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
          view,
          ctx,
          result,
          options,
          durationMs,
          origRenderResult: (res, opts, th, ctx2) =>
            orig?.renderResult?.(res, opts, th as Theme, ctx2 as never) ?? text,
        });
      }
      return orig?.renderResult?.(result, options, theme, ctx as never) ?? text;
    },
  };
}
