/**
 * The errored-tool-result frame: dwells the failure syntax — the shell
 * badge taxonomy (exit / signal / timeout / aborted), the width-aware
 * body with the bar column, the collapsed window — and paints the frame's
 * error background. The factory's renderResult error branch is the ONLY
 * composer (one entry spans the placeholder and the preview task); every
 * wrapper's failed-call rendering flows through `formatToolErrorResult`.
 * Pure formatting over explicit inputs — no module state beyond constants.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import { inertText, measurePlain } from "#src/core/ansi.ts";
import { linesOf } from "#src/core/lines.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";

import {
  clearToolHeaderBg,
  formatToolFrameHeaderText,
  formatToolHeaderName,
  setToolSuccessBg,
  type CustomBgText,
} from "./header.ts";
import { borderBar, injectBg } from "./render-shared.ts";
import { collapseTail, expandKeyHint } from "./tool-output.ts";
import type { CallState } from "./tool-services.ts";

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

/** The call-header row setter's inputs (the inline object form grew). */
export interface CallHeaderOpts {
  /** The tool label (arrow-prefixed when wrapping). */
  label: string;
  /** The file path (shortened via pathShortener). */
  filePath: string;
  /** The pi theme. */
  theme: PaletteTheme;
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
   * the palette's base tint.
   */
  status: CallState;
  /** The resolved palette. */
  palette: DiffPalette;
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
export function setCallHeader(text: CustomBgText, opts: CallHeaderOpts): void {
  if (opts.status === "error") {
    setToolErrorBg(text, opts.theme, opts.palette);
  } else if (opts.status === "pending") {
    // Streaming: transparent — the content Box's pending bg owns the row.
    clearToolHeaderBg(text);
  } else {
    setToolSuccessBg(text, opts.theme, opts.palette);
  }
  text.setText(
    formatToolFrameHeaderText(
      {
        label: opts.label,
        filePath: opts.filePath,
        theme: opts.theme,
        suffix: opts.suffix,
        topPad: 0,
        // The separator blank belongs to frames with a BODY below; a
        // pending frame has none — its own blank would stack on the
        // default shell's bottom padding (the two-blank gap).
        bottomPad: opts.status === "pending" ? 0 : 1,
      },
      opts.pathShortener,
      opts.cwd,
    ),
  );
}

/**
 * Apply the theme's error background to a Text component.
 *
 * @param text - The Text component to style.
 * @param theme - The active pi theme (falls back to the tool-box background).
 * @param palette - The resolved palette (the fallback background).
 */
export function setToolErrorBg(
  text: CustomBgText,
  theme: PaletteTheme,
  palette: DiffPalette,
): void {
  let background = palette.bgBase;
  try {
    // A theme without an error background may THROW or return
    // undefined/empty — either way the regular tool background serves.
    background = theme.getBgAnsi("toolErrorBg") || palette.bgBase;
  } catch {
    // Use the regular tool background when the theme has no error background.
  }
  text.setCustomBgFn((line: string) => injectBg(line, { baseBg: background }));
}

/**
 * The shell failure taxonomy read from an error message's status line.
 * Exit codes 128-255 are the signal range (killed/terminated) — a
 * different failure KIND than a plain non-zero exit (Ghostty's
 * command-blocks stripe makes the same distinction), and it earns its
 * own color.
 */
export interface ShellExitBadge {
  /** The failure kind. */
  kind: "error" | "signal" | "timeout" | "aborted";
  /** The exit code (error/signal) or timeout seconds (timeout). */
  value: number;
}

/**
 * UPSTREAM CONTRACT MIRROR — the pi SDK's bash/powershell failure path
 * (dist/core/tools/bash.js, `appendStatus`): a failed command THROWS, and
 * the agent loop reduces the throw to `createErrorToolResult(message)` —
 * the exit code survives only inside the message text, as one of three
 * appended status lines:
 *
 * "Command exited with code ${exitCode}"
 * "Command timed out after ${timeoutSecs} seconds"
 * "Command aborted"
 *
 * These patterns mirror those exact strings. A miss degrades to an
 * unbadged frame — never a broken one — so an upstream reword costs the
 * badge, nothing else.
 */
const EXIT_CODE_RE = /Command exited with code (\d+)$/;
const TIMEOUT_RE = /Command timed out after (\d+) seconds$/;
const ABORTED_SUFFIX = "Command aborted";

/**
 * Parse the shell failure status from an error message's tail.
 *
 * @param message - The tool error message (the SDK appends the status).
 * @returns The badge, or undefined when the tail carries no known status
 *   (a non-shell error, or an upstream message-format change — the frame
 *   then renders without a badge, degraded never broken).
 */
export function shellExitBadgeOf(message: string): ShellExitBadge | undefined {
  const exit = message.match(EXIT_CODE_RE);
  if (exit) {
    const code = Number(exit[1]);
    return code >= 128 && code <= 255
      ? { kind: "signal", value: code }
      : { kind: "error", value: code };
  }
  const timeout = message.match(TIMEOUT_RE);
  if (timeout) return { kind: "timeout", value: Number(timeout[1]) };
  if (message.endsWith(ABORTED_SUFFIX)) return { kind: "aborted", value: 0 };
  return undefined;
}

/**
 * The badge text for a shell failure status (the p10k lesson: the code
 * itself must be visible at a glance, not buried in the output tail).
 *
 * @param badge - The parsed status.
 * @param theme - The pi theme (colors).
 * @returns The styled badge text.
 */
function shellBadgeText(badge: ShellExitBadge, theme: PaletteTheme): string {
  const color = badge.kind === "signal" || badge.kind === "timeout" ? "warning" : "error";
  const label = shellBadgeLabel(badge);
  return theme.fg(color, theme.bold(label));
}

/**
 * The badge's plain text — one WORDED form per failure kind ("✗ exit 1",
 * "✗ exit 143", "✗ timeout 30s", "✗ aborted"): the bare "✗ 1" form it
 * replaces read as a cryptic glyph + number; the verb tells what the
 * code measures. The signal band shares the exit form — its distinct
 * warning color is the band's signal, and 143 IS the exit code.
 *
 * @param badge - The parsed status.
 * @returns The unstyled badge text.
 */
function shellBadgeLabel(badge: ShellExitBadge): string {
  switch (badge.kind) {
    case "timeout":
      return `✗ timeout ${badge.value}s`;
    case "aborted":
      return "✗ aborted";
    case "signal":
    case "error":
      return `✗ exit ${badge.value}`;
  }
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
  theme: PaletteTheme;
  /** The path shortener (the header path's shortening contract). */
  pathShortener: (p: string) => string;
  /** Whether ctrl+o expanded the window (full message). */
  expanded: boolean;
  /**
   * The configured left-edge indicator style; the bar column follows it
   * exactly like the diff view.
   */
  indicatorStyle: IndicatorStyle;
  /**
   * The styled Took footer ("" when unmeasured), framed below the body
   * with one blank row between (the native frame's composition).
   */
  took?: string;
  /** The visual render width (the preview task's width). */
  width: number;
}

/**
 * A failed call's error frame — the body the result slot renders under
 * the (still-visible) call header.
 *
 * Header ownership is decided by the TOOL KIND, never by whether the
 * args carried a path (a validation failure leaves the args empty while
 * the call header still shows the bare tool label): the shell tools'
 * call header is the command echo, so their frame needs a name header
 * of its own to carry the exit-code badge; every other tool's call
 * header already names the tool, so those frames render the body
 * alone.
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
  const { name, message, theme, pathShortener, expanded, indicatorStyle, took = "", width } = input;
  // Badge the shell failures into the header — the exit code leaves the
  // buried output tail and lands at the first glance. Other tools'
  // errors render unbadged AND headerless: the call header above
  // already names the tool (even on validation failures, where the args
  // and path are missing, the call header still shows the bare tool
  // label).
  const isShell = name === "bash" || name === "powershell";
  const badge = isShell ? shellExitBadgeOf(message) : undefined;
  const suffix = badge ? ` ${shellBadgeText(badge, theme)}` : "";
  const header = isShell
    ? `${formatToolFrameHeaderText(
        {
          meta: theme.fg("error", theme.bold(formatToolHeaderName(name))),
          theme,
          topPad: 0,
          bottomPad: 1,
          suffix,
        },
        pathShortener,
      )}\n`
    : "";
  // The row prefix: the bar glyph + one space in bar mode; EMPTY in
  // none mode — the frame Box's own padding is the single leading space
  // the row keeps (collapsing the column here means no second space
  // appears after the pad). The failure-kind coloring rides the glyph.
  const barKind = badge && badge.kind !== "error" ? "warning" : "error";
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
  // native frame's composition); none when unmeasured.
  const footer = took ? `\n\n${took}` : "";
  return `${header}${body.join("\n")}${footer}`;
}
