/**
 * The ls tool wrapper: execution delegates to the SDK's ls tool (via the
 * tool-wrapper factory); rendering draws a tree (├──/└── connectors) of
 * type-colored entries — directories in the accent color, known code files
 * in a syntax-family tint — collapsed to a line budget until ctrl+o.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { LsToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

import { SEQ_FG_DEFAULT } from "#src/core/escapes.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { PaletteTheme } from "#src/theme/scheme.ts";

import { renderHeaderLine } from "./ellipsis.ts";
import { assembleOutputBody } from "./output-assembly.ts";
import { expandHome } from "./paths.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { COLLAPSED_LINES, joinBodyTail, outputMemoOf } from "./tool-output.ts";
import { argsOf, argStr, headerPath, invalidArg, type ToolServices } from "./tool-services.ts";

/** Tree connectors: dim rules + the last-entry elbow. */
const TEE = "├── ";
const ELBOW = "└── ";

/**
 * The ls call header: the SDK's formatLsCall, byte for byte (toolTitle
 * name, accent linked path, toolOutput limit).
 *
 * @param args - The settled ls args.
 * @param theme - The pi theme.
 * @param cwd - The session working directory (the file link's base).
 * @returns The header row (no trailing gap — the caller owns it).
 */
function formatLsCall(args: Partial<LsToolInput>, theme: PaletteTheme, cwd?: string): string {
  const limit = args?.limit;
  const raw = argStr(args?.path);
  // Invalid → the error chip; otherwise the accent display path,
  // hyperlinked from the RAW arg (the SDK's linkPath shape — resolving
  // the shortened "~/x" would land under <cwd>/~/x).
  let pathDisplay = invalidArg(theme);
  if (raw !== null) {
    const path = headerPath(raw) ?? ".";
    const styled = theme.fg("accent", path);
    pathDisplay = getCapabilities().hyperlinks
      ? hyperlink(styled, pathToFileURL(resolve(cwd ?? process.cwd(), expandHome(raw) || ".")).href)
      : styled;
  }
  let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${pathDisplay}`;
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` (limit ${limit})`);
  }
  return text;
}

/**
 * Build the ls wrapper around `origLs`.
 *
 * @param origLs - The SDK ls tool to wrap.
 * @param services - Assembly services.
 * @returns The wrapped tool.
 */
export function createLsWrapper(origLs: ToolDefinition, services: ToolServices): ToolDefinition {
  return createToolWrapper(origLs, services, {
    renderShell: "default",
    renderCall: ({ text, view, ctx, renderArgs }) => {
      const { theme } = view;
      const args = argsOf<LsToolInput>(renderArgs);
      renderHeaderLine({
        text,
        prefix: "lh",
        view,
        ctx,
        services,
        body: formatLsCall(args, theme, ctx.cwd),
      });
      return text;
    },
    renderResult: ({ text, view, ctx, result, options, tookMs }) => {
      const { scheme, theme } = view;
      // Inert at intake (ADR 0004): filenames can carry control bytes too.
      // The derivation is memoized on the result object's identity.
      const derive = outputMemoOf(ctx.state);
      const derived = derive(result);
      const { entries } = derived;
      return assembleOutputBody({
        text,
        prefix: "l",
        lines: entries,
        isEmpty: entries.length === 0,
        budget: COLLAPSED_LINES.ls,
        derived,
        paletteIdentity: scheme.identity,
        tookMs,
        expanded: options.expanded,
        notice: derived.notice,
        theme,
        ctx,
        renderStyled: (shown, tail, hidden) => {
          // Tree rendering: one entry per row under a connector rule;
          // type coloring as before (directories accent, code tinted).
          // The entries carry no limit notice (DerivedOutput lifts it
          // into the footer), so a notice can never wear a connector.
          const rows = shown.map((entry, i) => {
            // The elbow only when this is the TRUE last entry (not the
            // collapse cut — hidden entries continue the tree).
            const connector = theme.fg(
              "muted",
              i === shown.length - 1 && i === entries.length - 1 ? ELBOW : TEE,
            );
            // The SDK's empty-directory sentinel renders as a muted note,
            // not a tree entry (find does the same for its no-files line).
            if (entry === "(empty directory)") {
              return `${theme.fg("muted", entry)}`;
            }
            if (entry.endsWith("/")) {
              return `${connector}${theme.fg("accent", theme.bold(entry))}`;
            }
            // Code-file detection reuses detectLanguage (the
            // SDK/Shiki-shared authority) — no second extension table.
            // The fgCode escape is channel-scoped like the theme's own
            // fg() closes (a full \x1b[0m would kill pi core's frame
            // canvas and whiten the row's tail padding).
            if (detectLanguage(entry)) {
              return `${connector}${scheme.fgCode}${entry}${SEQ_FG_DEFAULT}`;
            }
            return `${connector}${theme.fg("toolOutput", entry)}`;
          });
          return joinBodyTail(rows.join("\n"), tail, hidden);
        },
      });
    },
  });
}
