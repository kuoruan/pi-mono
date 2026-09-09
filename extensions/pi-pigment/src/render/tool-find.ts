/**
 * The find tool wrapper: execution delegates to the SDK's find tool (via
 * the tool-wrapper factory); rendering colorizes each result path by type —
 * the same family as ls (directories accent, code files a syntax tint), but
 * shaped for find's output: paths carry directory prefixes, so the dirname
 * renders dim and the basename carries the type color. The call header and
 * truncation notices delegate to the SDK's native renderer.
 */

import type { FindToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { FG_DEFAULT, inertText } from "#src/core/ansi.ts";
import { detectLanguage } from "#src/theme/highlight.ts";

import { accentEmphasis, emphasize, type EmphasisSpec } from "./pattern-emphasis.ts";
import { renderPlainOutput } from "./render-shared.ts";
import { attachPreviewTask, renderEmpty } from "./text-task.ts";
import { createToolWrapper } from "./tool-factory.ts";
import {
  COLLAPSED_LINES,
  collapsedView,
  elapsedOf,
  outputMemoOf,
  outputTaskKey,
} from "./tool-output.ts";
import { argsOf, type ToolServices } from "./tool-services.ts";

/** The SDK's bracketed limit-notice tail (find/grep/ls share the shape). */
export const NOTICE_TAIL =
  /^\[\d+(?:\.\d+)?[KMG]?B?(?: results| matches| entries)? limit reached(?:\. Use limit=[\d.]+[KMG]?B? for more[^\]]*)?\]$/;

/** The styleFindPath inputs. */
interface StyleFindPathOptions {
  /** The result path. */
  path: string;
  /** The pi theme (dim/accent/toolOutput fg). */
  theme: {
    fg(name: "dim" | "accent" | "toolOutput", text: string): string;
    bold(text: string): string;
  };
  /** The resolved palette (type colors). */
  palette: { fgCode: string };
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
    return theme.fg("dim", inertText(dirname)) + palette.fgCode + styledBase(basename) + FG_DEFAULT;
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
  // The call header keeps the SDK's own shape (pattern + path + limit —
  // no renderCall override); renderResult reads the settled glob from
  // ctx.args (present every frame, live and restored alike).
  return createToolWrapper(origFind, services, {
    renderShell: "default",
    renderResult: ({ text, palette, theme, ctx, result, options }) => {
      // Inert at intake (ADR 0004): the result carries raw paths. The
      // derivation is memoized on the result object's identity (one
      // lookup per trigger frame for a stable result).
      const derive = outputMemoOf(ctx.state);
      const derived = derive(result);
      const { entries: all } = derived;
      if (all.length === 0) return renderEmpty(text); // nothing to show — clear any stale task
      // The styling runs in the async preview task (the grep shape): a
      // trigger frame (partial, expand, invalidate) only checks the key;
      // the per-line work (anchor emphasis, type coloring) happens off
      // the frame, once per changed render.
      const callArgs = argsOf<FindToolInput>(ctx.args);
      const anchor = globAnchor(callArgs.pattern ?? "");
      const emphasisSpec = accentEmphasis(theme);
      const elapsed = elapsedOf(result) ?? 0;
      // The dim plain form is the placeholder AND the fallback — already
      // collapsed to the window (grep's shape): a large result set must
      // not flash the full listing before the styled render swaps in, nor
      // show it permanently when the task fails.
      const { shown: shownEntries, tail: plainTail } = collapsedView(all, {
        budget: COLLAPSED_LINES.find,
        expanded: options.expanded,
        result,
        theme,
      });
      const plain = `${renderPlainOutput(shownEntries, theme)}${plainTail ? `\n${plainTail}` : ""}`;
      // One computed key serves BOTH roles — find has no width-dependent
      // layout (same as grep): the width never joins the key.
      const taskKey = outputTaskKey({
        prefix: "f",
        derived,
        identity: palette.identity,
        elapsedMs: elapsed,
        expanded: options.expanded,
      });
      attachPreviewTask(text, {
        identity: taskKey,
        placeholder: plain,
        fallback: plain,
        invalidate: ctx.invalidate,
        key: () => taskKey,
        render: async () => {
          const { shown: lines, tail } = collapsedView(all, {
            budget: COLLAPSED_LINES.find,
            expanded: options.expanded,
            result,
            theme,
          });
          // The SDK appends truncation notices as a bracketed tail line —
          // style the path lines, pass notices through muted.
          const styled = lines.map((line) => {
            // The SDK's only bracketed output form is the truncation
            // notice (the payload is templated — `[1000 results limit
            // reached. Use limit=2000 for more, or refine pattern]`,
            // `[50.0KB limit reached]` — so match the shape, not the
            // literal). Everything else — including bracketed filenames
            // like `[note].md` — is a path.
            if (NOTICE_TAIL.test(line)) {
              return theme.fg("warning", inertText(line));
            }
            if (line === "No files found matching pattern") {
              return theme.fg("muted", line);
            }
            return styleFindPath({ path: line, theme, palette, anchor, emphasis: emphasisSpec });
          });
          return tail ? `${styled.join("\n")}\n${tail}` : styled.join("\n");
        },
      });
      return text;
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
