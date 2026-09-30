/**
 * The errored-tool-result frame: dwells the failure syntax — the shell
 * badge taxonomy (exit / signal / timeout / aborted / terminated), the
 * width-aware body with the bar column, the collapsed window — and paints
 * the frame's error background. The factory's renderResult error branch is
 * the ONLY composer (one entry spans the placeholder and the preview task);
 * every wrapper's failed-call rendering flows through
 * `formatToolErrorResult`. Pure formatting over explicit inputs — no
 * module state beyond constants.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import { inertText, measurePlain } from "#src/core/ansi.ts";
import { linesOf } from "#src/core/lines.ts";
import type { ResolvedTheme, RenderTheme } from "#src/theme/scheme.ts";

import { renderHeaderLine } from "./ellipsis.ts";
import {
  clearToolHeaderBg,
  formatToolFrameHeaderText,
  setToolSuccessBg,
  type CustomBgText,
} from "./header.ts";
import { injectBg } from "./inject-bg.ts";
import { borderBar } from "./row-frame.ts";
import type { FrameView } from "./session.ts";
import { isShellTool, shellBadgeColorOf, shellExitBadgeOf } from "./shell-status.ts";
import type { PreviewTextHost } from "./text-task.ts";
import { collapseTail, expandKeyHint, tookFooter } from "./tool-output.ts";
import type { CallState, RenderContext, ToolServices } from "./tool-services.ts";

/**
 * The error-frame body's collapsed line budget — the same affordance the
 * SDK's own renderers honor (bash's BASH_PREVIEW_LINES, the fallback's
 * FALLBACK_PREVIEW_LINES): collapsed shows a window with an expand hint,
 * ctrl+o shows everything. The SDK bundles the whole failed-command
 * output into the message, so multi-line bodies are the norm.
 *
 * The number mirrors the tool-execution fallback's 10-line window rank
 * (an error frame is a fallback surface too), not bash's 5: error
 * messages carry the command's output PLUS the appended status tail,
 * and the status line itself must stay visible in the window (a 5-line
 * window can leave "Command exited with code N" — the one line the badge
 * mirrors — clipped out, the worst place to hide it).
 */
const ERROR_PREVIEW_LINES = 10;

/**
 * The frame's placeholder render width (the preview task re-renders at
 * the TUI's real width immediately — this value only shapes the first
 * synchronous frame, matching the plain-fallback's 120-column window).
 */
export const ERROR_FRAME_DEFAULT_WIDTH = 120;

/** The call-header row setter's inputs (frame composition + the task's frame). */
export interface CallHeaderOpts {
  /** The tool label (arrow-prefixed when wrapping). */
  label: string;
  /** The file path (shortened via pathShortener). */
  filePath: string;
  /** The header's tail suffix (stats chips). */
  suffix: string;
  /** The path-shortening function. */
  pathShortener: (p: string) => string;
  /** The session's working directory (the file link's base). */
  cwd?: string;
  /**
   * The call's outcome: error → the theme's error bg; pending (still
   * streaming) → no custom bg (the default shell's pending Box bg shows
   * through — no success tint leaks onto an undecided frame); success →
   * the scheme's base tint.
   */
  status: CallState;
  /** The frame's derived view (scheme + pi theme). */
  view: FrameView;
  /** The render context (expand state + invalidate). */
  ctx: RenderContext<object>;
  /** The injected services (the ellipsis switch). */
  services: ToolServices;
  /** The task key prefix (per tool). */
  prefix: string;
}

/**
 * The call-header row setter shared by the write/edit wrappers — ONE home
 * for the frame-header composition AND the outcome-following background:
 * success/canvas tint while the call streams or succeeds, the theme's
 * ERROR tint once this call is an error one. The flip matters on the
 * default shell because the header Text's custom bg composes OVER the
 * content Box's own bg on its rows — without it, a re-render after the
 * error lands repaints the header row success-tinted inside an otherwise
 * all-error frame (the aborted-create "white ← create row" report).
 *
 * @param text - The call header's Text component.
 * @param opts - The header's inputs (label/path/suffix/theme + outcome).
 */
export function setCallHeader(text: CustomBgText & PreviewTextHost, opts: CallHeaderOpts): void {
  const { scheme, theme } = opts.view;
  if (opts.status === "error") {
    setToolErrorBg(text, theme, scheme);
  } else if (opts.status === "pending") {
    // Streaming: transparent — the content Box's pending bg owns the row.
    clearToolHeaderBg(text);
  } else {
    setToolSuccessBg(text, theme, scheme);
  }
  const body = formatToolFrameHeaderText(
    {
      label: opts.label,
      filePath: opts.filePath,
      theme,
      topPad: 0,
      bottomPad: 0,
    },
    opts.pathShortener,
    opts.cwd,
  );
  // Suffix split BEFORE fitting (ADR 0008) — the chips stay pinned.
  renderHeaderLine({
    text,
    prefix: opts.prefix,
    view: opts.view,
    ctx: opts.ctx,
    services: opts.services,
    body,
    suffix: opts.suffix,
  });
}

/**
 * Apply the theme's error background to a Text component.
 *
 * @param text - The Text component to style.
 * @param theme - The active pi theme (falls back to the tool-box background).
 * @param scheme - The resolved scheme (the fallback background).
 */
export function setToolErrorBg(
  text: CustomBgText,
  theme: RenderTheme,
  scheme: ResolvedTheme,
): void {
  let background = scheme.bgBase;
  try {
    // A theme without an error background may THROW or return
    // undefined/empty — either way the regular tool background serves.
    background = theme.getBgAnsi("toolErrorBg") || scheme.bgBase;
  } catch {
    // Fall through to bgBase below.
  }
  text.setCustomBgFn((line: string) => injectBg(line, { baseBg: background }));
}

/**
 * The error frame's inputs — one object so the width-aware preview task
 * and the synchronous placeholder share a single builder.
 */
export interface ErrorFrameInput {
  /** The tool's name (badge parsing only for bash/powershell). */
  name: string;
  /** The failure message (rendered inert first). */
  message: string;
  /** The pi theme. */
  theme: RenderTheme;
  /** Whether ctrl+o expanded the window (full message). */
  expanded: boolean;
  /**
   * The configured left-edge indicator style; the bar column follows it
   * exactly like the diff view.
   */
  indicatorStyle: IndicatorStyle;
  /**
   * The measured execution time (undefined when unmeasured — no footer),
   * rendered beneath the body with one blank row between (the native
   * frame's composition); the color follows the bar kind (the shell
   * badge's failure kind, error for non-shell frames).
   */
  tookMs?: number;
  /** The visual render width (the preview task's width). */
  width: number;
}

/**
 * A failed call's error frame — the body the result slot renders under
 * the (still-visible) call header.
 *
 * The body is WIDTH-AWARE: each logical line pre-wraps to the render
 * width, so the bar column leads every visual row (the TUI's own wrap
 * would leave continuation rows bare).
 *
 * @param input - The frame's inputs (see ErrorFrameInput).
 * @returns The frame's text (header row + bar body + optional Took
 * footer, no trailing pad).
 */
export function formatToolErrorResult(input: ErrorFrameInput): string {
  const { name, message, theme, expanded, indicatorStyle, tookMs, width } = input;
  // Body-only (the call header above already names the tool — the
  // SDK's own error frames never repeat it): the gapless shell header
  // needs one separator blank, anything else needs nothing.
  const header = isShellTool(name) ? "\n" : "";
  // No isShellTool guard: only the shell tools' own status lines parse.
  const badge = shellExitBadgeOf(message);
  // Deliberately no command: the bar is frame-level (failed), the dim lives on the header suffix only.
  const barKind = badge ? shellBadgeColorOf(badge) : "error";
  const barGlyph = borderBar(indicatorStyle);
  const prefix = barGlyph ? `${theme.fg(barKind, barGlyph)} ` : "";
  // Inert first (ADR 0004), then the SDK renderers' own pattern: a
  // collapsed window with the expand hint, everything on ctrl+o.
  const lines = linesOf(inertText(message));
  const hidden = expanded ? 0 : Math.max(0, lines.length - ERROR_PREVIEW_LINES);
  const shown = expanded ? lines : lines.slice(0, ERROR_PREVIEW_LINES);
  // Pre-wrap each logical line to the render width so EVERY visual row
  // carries the prefix.
  const bodyWidth = Math.max(1, width - measurePlain(prefix));
  const body = shown.flatMap((line) =>
    wrapTextWithAnsi(line, bodyWidth).map((row) => `${prefix}${theme.fg("error", row)}`),
  );
  // The hint row keeps the SDK hint's single-space indent; the tail's
  // grammar is the shared collapseTail authority (one user-visible
  // invariant across every collapsed window).
  if (hidden > 0) {
    body.push(` ${collapseTail(hidden, theme, expandKeyHint(theme))}`);
  }
  // The Took footer joins beneath the body (one blank row between, the
  // native frame's composition); none when unmeasured. Its color is the
  // bar kind — the frame's one failure-kind reading (error for non-shell
  // frames, the badge's kind for shell ones).
  const footer = tookMs !== undefined ? `\n\n${tookFooter(tookMs, theme, barKind)}` : "";
  return `${header}${body.join("\n")}${footer}`;
}
