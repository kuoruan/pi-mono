/**
 * The shared shell-tool wrapper (bash + powershell — the SDK's two
 * `createShellToolDefinition` instances): execution delegates verbatim;
 * rendering colors the COMMAND in the shell's own grammar — the one thing
 * whose language is known with certainty — and leaves the OUTPUT to the
 * SDK's native renderer (timing, preview windows, truncation footers).
 *
 * Why not color the output (design decision): guessing an output's
 * language from the command was fragile (cd-prefixed anchors, heredoc
 * bodies, mixed producers) and misfires are worse than plain. The command
 * is where the scanning value is, and its grammar needs no guessing —
 * including injected regions (@aliou/sh AST): heredoc bodies (python3 <<
 * EOF feeds python), heredoc file-writes (cat > app.py << EOF declares
 * the target's language), and inline code args (python -c '...').
 *
 * Inert text (ADR 0004): the OUTPUT is already sanitized upstream — the
 * SDK's shell executors strip ANSI and control characters at the executor
 * exit. The COMMAND is model-authored data and gets inertText at intake
 * (both display paths), before it joins our own escape chrome.
 */

import type { BashToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { inertText } from "#src/core/ansi.ts";
import { hlBlock } from "#src/theme/highlight.ts";
import { resolveDiffPalette, type DiffPalette, type PaletteTheme } from "#src/theme/palette.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

import { astInjectRegions, fallbackHeredocRegions } from "./heredoc-inject.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { argsSettled, type ShellState, type ToolServices, argsOf } from "./tool-services.ts";

/** The per-shell rendering inputs: the grammar and the prompt glyph. */
export interface ShellToolProfile {
  /** The Shiki grammar for this shell's commands. */
  language: "shellscript" | "powershell";
  /** The prompt shown before the command ("$" / "PS>"). */
  prompt: string;
}

/**
 * Build the shared shell wrapper around `orig` (bash or powershell).
 *
 * @param orig - The SDK shell tool definition to wrap.
 * @param services - Assembly services.
 * @param profile - The shell's grammar and prompt.
 * @returns The wrapped tool.
 */
export function createShellWrapper(
  orig: ToolDefinition,
  services: ToolServices,
  profile: ShellToolProfile,
): ToolDefinition {
  return createToolWrapper<ShellState>(orig, services, {
    // Explicitly the DEFAULT shell: the content Box's bgFn paints the
    // frame's background across every result row (the native renderer's
    // timing/packing child Texts compose inside it).
    renderShell: "default",
    onError: (ctx) => {
      ctx.state.endedAt ??= Date.now();
    },
    renderCall: ({ text, theme, ctx, renderArgs }) => {
      const callArgs = argsOf<BashToolInput>(renderArgs);
      const command = callArgs.command ?? "";
      ctx.state.command = command;
      // SDK parity: the result renderer's timing display reads these.
      if (ctx.executionStarted && ctx.state.startedAt === undefined) {
        ctx.state.startedAt = Date.now();
        ctx.state.endedAt = undefined;
      }
      const timeoutSuffix =
        callArgs.timeout !== undefined ? theme.fg("muted", ` (timeout ${callArgs.timeout}s)`) : "";

      // The highlighted command, once ready: shell-grammar colors over a
      // toolTitle base (uncolored tokens inherit it). Cached per command
      // AND theme identity — a mid-session theme switch re-highlights
      // instead of serving the old theme's colors; arg-streaming frames
      // re-render cheaply until args complete.
      const paletteNow = resolveDiffPalette(theme);
      const cacheKey = `${paletteNow.identity}\u0000${command}`;
      const cached =
        ctx.state.commandHighlightFor === cacheKey
          ? (ctx.state.commandHighlight as string | undefined)
          : undefined;
      if (cached !== undefined) {
        text.setText(`${profile.prompt} ${cached}${timeoutSuffix}`);
        return text;
      }

      // Plain display now; the highlighted form swaps in via invalidate.
      const safeCommand = inertText(command);
      text.setText(
        theme.fg("toolTitle", theme.bold(`${profile.prompt} ${safeCommand}`)) + timeoutSuffix,
      );

      // Highlight once the args settle (streaming frames stay plain — the
      // command is still growing; highlighting churn would flicker).
      if (argsSettled(ctx) && command && ctx.state.commandHighlightFor !== cacheKey) {
        ctx.state.commandHighlightFor = cacheKey;
        const base = theme.getFgAnsi("toolTitle");
        // Inert at intake (ADR 0004): the command is model-authored data —
        // control bytes in it must not reach the terminal as sequences.
        // (The highlighter's own escapes are OUR chrome and pass through.)
        // safeCommand is the SAME inert form computed above — reuse it.
        void renderShellCommand(safeCommand, profile.language, paletteNow, theme)
          .then((highlighted) => {
            // Compose over the base: renderTokensAnsi closes each token's
            // fg with ESC[39m — re-open the base after every close so
            // uncolored segments (flags, paths) keep the title color.
            const composed = highlighted.replaceAll("\x1b[39m", `\x1b[39m${base}`);
            // Stale guard: the command moved on while we highlighted, or
            // the cache key was superseded (a theme switch kicked a fresh
            // highlight — the older one's colors must not land over it).
            if (ctx.state.command !== command || ctx.state.commandHighlightFor !== cacheKey) {
              return;
            }
            ctx.state.commandHighlight = `${base}${composed}`;
            ctx.invalidate();
            return undefined;
          })
          .catch(() => {
            /* highlighting failed: the plain display stands */
          });
      }
      return text;
    },

    // The output renders through the SDK's native result renderer —
    // timing, preview windows, truncation footers. lastComponent is
    // withheld (undefined): the native renderer builds its own Container
    // and must not receive our width-aware Text.
    renderResult: ({ text, theme, ctx, result, options, origRenderResult }) =>
      origRenderResult(result, options, theme, { ...ctx, lastComponent: undefined }) ?? text,
  });
}

/**
 * Render a shell command with its code regions injected: the parsed AST
 * (@aliou/sh) names each region — heredoc bodies, heredoc file-writes,
 * inline code arguments — and everything between renders in the command's
 * shell grammar. Parse failures fall back to the line scanner (heredocs
 * only), and its failures degrade to pure shell coloring.
 *
 * @param command - The inert command text.
 * @param shellLanguage - The command's shell grammar.
 * @param palette - The resolved palette.
 * @param theme - The active pi theme.
 * @returns The highlighted command text.
 */
async function renderShellCommand(
  command: string,
  shellLanguage: "shellscript" | "powershell",
  palette: DiffPalette,
  theme: PaletteTheme,
): Promise<string> {
  // Powershell has no @aliou/sh grammar — the AST path is bash-only; its
  // commands render purely in the powershell grammar.
  const regions =
    shellLanguage === "shellscript" ? await bashInjectRender(command, palette, theme) : null;
  if (regions !== null) return regions;
  const lines = await hlBlock({
    code: command,
    language: shellLanguage,
    palette,
    piTheme: theme,
  });
  return lines.join("\n");
}

/**
 * The bash injection path: AST regions when the parse succeeds, the
 * scanner fallback when it throws.
 *
 * @param command - The inert command text.
 * @param palette - The resolved palette.
 * @param theme - The active pi theme.
 * @returns The rendered command, or null when even the fallback fails
 *   (never — the scanner always yields segments).
 */
async function bashInjectRender(
  command: string,
  palette: DiffPalette,
  theme: PaletteTheme,
): Promise<string> {
  // One region model, two producers: the AST path when the parse holds,
  // the line scanner when it throws (garbage input, or the upstream
  // control-flow+heredoc bug). Both emit InjectRegion[] in source order —
  // a single assembly loop serves both.
  const regions = astInjectRegions(command) ?? fallbackHeredocRegions(command);
  // Byte-faithful reassembly: every piece highlights in its own grammar,
  // then rejoins the ORIGINAL line structure. Each piece carries its text
  // plus the boundary it ENDS at (the separator to the next piece: "\n"
  // when the boundary is a line break — hlBlock trims one trailing
  // newline — and "" when the boundary is mid-line, an inline code
  // region's edges). The LAST piece's joinAfter is never consumed (the
  // assembler's pinned convention: a trailing newline the command ends
  // with stays trimmed, the shape tests pin its absence).
  const pieces: Array<{ text: string; joinAfter: string }> = [];
  const take = async (from: number, to: number, language: BundledLanguage): Promise<void> => {
    const lines = await hlBlock({
      code: command.slice(from, to),
      language,
      palette,
      piTheme: theme,
    });
    pieces.push({
      text: lines.join("\n"),
      joinAfter: command.charAt(to - 1) === "\n" ? "\n" : "",
    });
  };
  let cursor = 0;
  for (const region of regions) {
    if (region.start < cursor || region.end > command.length) continue; // overlap/garbage: skip
    if (region.end <= region.start) continue;
    if (cursor < region.start) await take(cursor, region.start, "shellscript");
    await take(region.start, region.end, region.language);
    cursor = region.end;
  }
  if (cursor < command.length) await take(cursor, command.length, "shellscript");
  return pieces
    .map((piece, i) => (i === pieces.length - 1 ? piece.text : piece.text + piece.joinAfter))
    .join("");
}
