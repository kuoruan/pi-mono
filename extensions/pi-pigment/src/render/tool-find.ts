/**
 * The find tool wrapper: execution delegates to the SDK's find tool (via
 * the tool-wrapper factory); rendering colorizes each result path by type —
 * the same family as ls (directories accent, code files a syntax tint), but
 * shaped for find's output: paths carry directory prefixes, so the dirname
 * renders dim and the basename carries the type color. The call header delegates to
 * the SDK's native renderer; truncation notices ride the shared footer.
 */

import type { FindToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { inertText } from "#src/core/ansi.ts";
import { SEQ_FG_DEFAULT } from "#src/core/escapes.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";

import { renderHeaderLine } from "./ellipsis.ts";
import { assembleOutputBody } from "./output-assembly.ts";
import { accentEmphasis, emphasize, type EmphasisSpec } from "./pattern-emphasis.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { COLLAPSED_LINES, joinBodyTail, outputMemoOf } from "./tool-output.ts";
import { argsOf, argStr, headerPath, invalidArg, type ToolServices } from "./tool-services.ts";

/**
 * The find call header: the SDK's formatFindCall, byte for byte
 * (toolTitle name, accent pattern, toolOutput path + limit).
 *
 * @param args - The settled find args.
 * @param theme - The pi theme.
 * @returns The header row (no trailing gap — the caller owns it).
 */
function formatFindCall(args: Partial<FindToolInput>, theme: PaletteTheme): string {
  const pattern = argStr(args?.pattern);
  const path = headerPath(args?.path);
  const limit = args?.limit;
  const invalid = invalidArg(theme);
  let text =
    theme.fg("toolTitle", theme.bold("find")) +
    " " +
    (pattern === null ? invalid : theme.fg("accent", pattern || "")) +
    theme.fg("toolOutput", ` in ${path === null ? invalid : path}`);
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` (limit ${limit})`);
  }
  return text;
}

/** The styleFindPath inputs. */
interface StyleFindPathOptions {
  /** The result path. */
  path: string;
  /** The pi theme (dim/accent/toolOutput fg, success canvas bg). */
  theme: Pick<PaletteTheme, "fg" | "bold" | "getBgAnsi">;
  /** The resolved palette (type colors). */
  palette: Pick<DiffPalette, "fgCode">;
  /** The glob's anchor run ("" emphasizes nothing). */
  anchor: string;
  /** The emphasis spec (bold + accent fg). */
  emphasis: EmphasisSpec;
}

/**
 * Style one find result path: dim dirname, type-colored basename, the
 * emphasis anchor brightened inside the basename.
 *
 * @param options - The path's inputs.
 * @returns The styled line.
 */
function styleFindPath(options: StyleFindPathOptions): string {
  const { path, theme, palette, anchor, emphasis } = options;
  const slash = path.lastIndexOf("/");
  const dirname = slash === -1 ? "" : path.slice(0, slash + 1);
  const basename = slash === -1 ? path : path.slice(slash + 1);
  // The emphasis anchor brightens the matched run inside the basename —
  // literal semantics (the glob already did the matching; the anchor is
  // just the brightest signal of WHAT matched).
  const styledBase = (content: string): string =>
    anchor
      ? emphasize({
          content: inertText(content),
          pattern: anchor,
          flags: { literal: true, ignoreCase: true },
          emphasis,
          baseBg: theme.getBgAnsi("toolSuccessBg"),
        })
      : inertText(content);
  // Directories: fd marks them with a trailing slash, so the basename
  // slice would be empty — strip it first and re-split, keeping the same
  // dim-prefix + emphasized-name grammar as the file branches below. The
  // trailing slash comes back after the name (the directory marker, as
  // the ls wrapper keeps it).
  if (path.endsWith("/")) {
    const stripped = path.slice(0, -1);
    const s = stripped.lastIndexOf("/");
    const dir = s === -1 ? "" : stripped.slice(0, s + 1);
    const name = s === -1 ? stripped : stripped.slice(s + 1);
    return (
      theme.fg("dim", inertText(dir)) +
      theme.fg("accent", theme.bold(styledBase(name))) +
      theme.fg("dim", "/")
    );
  }
  // Code-file detection reuses detectLanguage (the SDK/Shiki-shared
  // authority) — no second extension table to drift.
  if (detectLanguage(basename)) {
    // The fgCode escape closes channel-scoped (the tool-ls rule): a full
    // RESET would kill pi's line-level frame canvas and expose the terminal
    // default behind the row tail.
    return (
      theme.fg("dim", inertText(dirname)) + palette.fgCode + styledBase(basename) + SEQ_FG_DEFAULT
    );
  }
  return theme.fg("dim", inertText(dirname)) + theme.fg("toolOutput", styledBase(basename));
}

/**
 * Build the find wrapper around `origFind`.
 *
 * @param origFind - The SDK find tool to wrap.
 * @param services - Assembly services.
 * @returns The wrapped tool.
 */
export function createFindWrapper(
  origFind: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  // The call header is ours (mirrors the SDK's shape).
  return createToolWrapper(origFind, services, {
    renderShell: "default",
    renderCall: ({ text, view, ctx, renderArgs }) => {
      const { piTheme: theme } = view;
      const args = argsOf<FindToolInput>(renderArgs);
      renderHeaderLine({
        text,
        prefix: "fh",
        view,
        ctx,
        services,
        body: formatFindCall(args, theme),
      });
      return text;
    },
    renderResult: ({ text, view, ctx, result, options, tookMs }) => {
      const { palette, piTheme: theme } = view;
      // Inert at intake (ADR 0004): the result carries raw paths. The
      // derivation is memoized on the result object's identity (one
      // lookup per trigger frame for a stable result).
      const derive = outputMemoOf(ctx.state);
      const derived = derive(result);
      const { entries: all } = derived;
      // The glob anchor rides the styled closure (settled per the SDK
      // contract — no key stamp needed).
      const callArgs = argsOf<FindToolInput>(ctx.args);
      const anchor = globAnchor(callArgs.pattern ?? "");
      const emphasisSpec = accentEmphasis(theme);
      return assembleOutputBody({
        text,
        prefix: "f",
        lines: all,
        isEmpty: all.length === 0,
        budget: COLLAPSED_LINES.find,
        derived,
        paletteIdentity: palette.identity,
        tookMs,
        expanded: options.expanded,
        notice: derived.notice,
        theme,
        ctx,
        renderStyled: (lines, tail, hidden) => {
          // Every shown line is a path or the SDK's empty-result sentinel
          // — the limit notice was lifted into the footer (DerivedOutput).
          const styled = lines.map((line) => {
            if (line === "No files found matching pattern") {
              return theme.fg("muted", line);
            }
            return styleFindPath({ path: line, theme, palette, anchor, emphasis: emphasisSpec });
          });
          return joinBodyTail(styled.join("\n"), tail, hidden);
        },
      });
    },
  });
}

/**
 * The emphasis anchor for a find call: glob patterns are not literals
 * (star-dot-ts matches nothing as a substring), so emphasize the longest
 * metacharacter-free run's final path segment instead — a
 * "anywhere/handlers.ts" glob anchors "handlers.ts" (the FULL final
 * segment, extension included). A run is usable when its final segment
 * has a stem before the extension: "handlers.ts" yes, bare ".ts"/"ts"
 * no (a bare extension as a substring would light up half the repo).
 * Brace alternations split into alternatives — "{handlers,index}.ts"
 * anchors whichever alternative is longest (one anchor cannot cover all
 * alternatives; the longest is the least-wrong single choice).
 *
 * @param pattern - The find call's glob pattern.
 * @returns The anchor substring, or "" when the glob carries no usable run.
 */
export function globAnchor(pattern: string): string {
  const runs = pattern
    // Character classes are metacharacter WHOLESALE: `[lL]icense` must
    // not contribute "lL" as a literal run (it matches no filename) —
    // split on them like any other metacharacter (the flanking text
    // stays as independent runs, each a legitimate partial-match anchor).
    .replace(/\[[^\]]*\]/g, "!")
    .split(/[*?{}()!,]/)
    // Anchor candidates are stem-ish runs: a run is usable when its final
    // path segment (after any slash) has a stem before the extension —
    // "/handlers.ts" anchors "handlers.ts" (full segment); ".ts"/"ts"
    // (no stem) anchor noise, not signal.
    .map((run) => run.slice(run.lastIndexOf("/") + 1))
    .filter((run) => {
      const stem = run.slice(0, run.indexOf(".") === -1 ? run.length : run.indexOf("."));
      return stem.length >= 2;
    });
  if (runs.length === 0) return "";
  let best = runs[0] ?? "";
  for (const run of runs) if (run.length > best.length) best = run;
  return best;
}
