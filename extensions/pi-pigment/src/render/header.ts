/**
 * Tool-frame header formatting: the boxed tool titles, body padding, and
 * the summary chip shared by the tool wrappers (error frames live in
 * error-frame.ts). Pure formatting over explicit inputs — no module state
 * beyond constants, no environment reads (terminal sizing lives in
 * term.ts, path shortening in paths.ts).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

import { inertText, RESET } from "#src/core/ansi.ts";
import { linesOf } from "#src/core/lines.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";

import { injectBg } from "./inject-bg.ts";

/** Tool names that get the arrow prefix in headers. */
const ARROW_PREFIXED_TOOL_HEADERS = new Set(["write", "create", "edit"]);

/** Indent for tool result lines (the native renderers' own shape). */
const TOOL_RESULT_INDENT = " ";

/**
 * Compose a tool result line: the result indent + themed segments joined
 * by single spaces. Empty or absent segments drop out; when nothing is
 * live the line itself is absent ("") — the header suffix and the plain
 * fallback both rely on that.
 *
 * @param segments - The styled segments (already themed; falsy ones drop).
 * @returns The composed line, or "" when no segment is live.
 */
export function resultLine(...segments: Array<string | undefined>): string {
  const live = segments.filter((segment): segment is string => !!segment);
  return live.length ? TOOL_RESULT_INDENT + live.join(" ") : "";
}

/**
 * Prefix wrapped tool names with the arrow marker pi uses for mutations.
 *
 * @param name - The tool name.
 * @returns The display name.
 */
export function formatToolHeaderName(name: string): string {
  return ARROW_PREFIXED_TOOL_HEADERS.has(name) ? `← ${name}` : name;
}

/**
 * Render a file path with the tool title color, tilde-shortened.
 *
 * @param theme - The active pi theme.
 * @param filePath - The path to render.
 * @param pathShortener - The path-shortening function.
 * @param cwd - The session working directory (the file link's base).
 * @returns The styled path.
 */
export function formatToolHeaderPath(
  theme: Pick<PaletteTheme, "fg">,
  filePath: string,
  pathShortener: (p: string) => string,
  cwd?: string,
): string {
  // Inert before shorten (ADR 0004): the path is model-produced — the
  // same trust level as a bash command. A control-byte path may fail the
  // shortener's match and show in full; correctness before prettiness.
  if (!filePath) return "";
  const styled = theme.fg("toolTitle", pathShortener(inertText(filePath)));
  // OSC-8 file link, the same affordance the native renderers give their
  // tool paths (linkPath's shape): capability-gated, wrapping the ALREADY
  // inert text — the order is a hard constraint, inertText would shred
  // the wrap's escapes into visible glyphs.
  if (!getCapabilities().hyperlinks) return styled;
  return hyperlink(styled, pathToFileURL(resolve(cwd ?? process.cwd(), filePath)).href);
}

/**
 * `+N -M` summary chip with the palette's diff colors.
 *
 * Chips close with the BARE reset (core/ansi RESET), never palette.rowReset:
 * the header row's background is INJECTED by the frame's customBgFn (injectBg
 * re-opens its baseBg after every reset), not painted by the chip itself. A
 * rowReset close would re-open the palette's bgBase AFTER the injected one and
 * overpaint the row tail — the mechanism that kept a stale canvas behind the
 * chips across theme switches. The chip owns its foreground only; the
 * background is the row's.
 *
 * @param a - Added line count.
 * @param d - Removed line count.
 * @param palette - The palette snapshot (current by default).
 * @returns The styled summary.
 */
export function summarize(a: number, d: number, palette: DiffPalette): string {
  const p: string[] = [];
  if (a > 0) p.push(`${palette.fgAdded}+${a}${RESET}`);
  if (d > 0) p.push(`${palette.fgRemoved}-${d}${RESET}`);
  return p.length ? p.join(" ") : `${palette.fgDim}no changes${RESET}`;
}

/**
 * Indent every line of a rendered body with the tool-box background.
 *
 * @param rendered - The rendered diff body.
 * @param palette - The resolved palette (background indent).
 * @returns The padded body.
 */
export function padDiffBody(rendered: string, palette: DiffPalette): string {
  const leftPad = `${palette.bgBase}${palette.rowReset}`;
  return linesOf(rendered)
    .map((line) => `${leftPad}${line}`)
    .join("\n");
}

/** Options for the tool frame header: label/path or a meta string, plus framing. */
export interface ToolFrameHeaderOpts {
  /** Blank lines above the header text. */
  topPad?: number;
  /** Blank lines below the header text. */
  bottomPad?: number;
  /** Text appended after the header line (e.g. stats chips). */
  suffix?: string;
  /** Tool name for the label variant (arrow-prefixed when wrappable). */
  label?: string;
  /** File path for the label variant (shortened via pathShortener). */
  filePath?: string;
  /** Theme for the label variant; the meta variant renders pre-styled text. */
  theme?: PaletteTheme;
  /** Pre-styled meta line; books the label/path form and renders as-is. */
  meta?: string;
}

/** The theme-less pass-through (meta callers render already-styled text). */
const PASSTHROUGH_THEME = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

/**
 * Format the header text line (no background): the tool label + path, or a
 * pre-styled meta line, framed by the requested blank rows above/below.
 *
 * @param opts - The header options (label/path or meta, theme, padding,
 *   suffix).
 * @param pathShortener - The path-shortening function.
 * @param cwd - The session working directory (the file link's base).
 * @returns The header text.
 */
export function formatToolFrameHeaderText(
  opts: ToolFrameHeaderOpts,
  pathShortener: (p: string) => string,
  cwd?: string,
): string {
  const { topPad = 0, bottomPad = 0, suffix = "", label, filePath, theme, meta } = opts;
  // ONE framing wraps whichever core line the opts describe.
  let line: string;
  if (meta !== undefined && meta !== null) {
    line = `${meta}${suffix}`;
  } else {
    const themed = theme ?? PASSTHROUGH_THEME;
    // The path segment drops out entirely without a filePath — a bare
    // space separator would trail the label.
    const pathSegment = filePath
      ? ` ${formatToolHeaderPath(themed, filePath, pathShortener, cwd)}`
      : "";
    line = `${themed.fg("toolTitle", themed.bold(formatToolHeaderName(label ?? "")))}${pathSegment}${suffix}`;
  }
  return `${"\n".repeat(topPad)}${line}${"\n".repeat(bottomPad)}`;
}

/** A Text-like component with an optional per-line custom background. */
export interface CustomBgText {
  /** Replaces the component's rendered text. */
  setText(text: string): void;
  /**
   * Sets the per-line background painter (pi-tui's official setter — writing the private field
   * directly skips its render-cache invalidation).
   */
  setCustomBgFn(fn?: (line: string) => string): void;
}

/**
 * Apply the success background to a Text component (the header row of a
 * succeeded call): the theme's RAW success slot — the same escape the
 * TUI's frame Box paints — with the derived canvas as the fallback (the
 * error twin, setToolErrorBg, reads its slot the same way).
 *
 * @param text - The Text component to style.
 * @param theme - The active pi theme (the success slot source).
 * @param palette - The resolved palette (the fallback background).
 */
export function setToolSuccessBg(
  text: CustomBgText,
  theme: PaletteTheme,
  palette: DiffPalette,
): void {
  let background = palette.bgBase;
  try {
    // A theme without a success background may THROW or return
    // undefined/empty — either way the derived canvas serves.
    background = theme.getBgAnsi("toolSuccessBg") || palette.bgBase;
  } catch {
    // Use the derived canvas when the theme has no success background.
  }
  text.setCustomBgFn((line: string) => injectBg(line, { baseBg: background }));
}

/**
 * Remove any custom background from a Text component.
 *
 * @param text - The Text component to reset.
 */
export function clearToolHeaderBg(text: CustomBgText): void {
  text.setCustomBgFn(undefined);
}
