/**
 * The ls tool wrapper: execution delegates to the SDK's ls tool (via the
 * tool-wrapper factory); rendering draws a tree (├──/└── connectors) of
 * type-colored entries — directories in the accent color, known code files
 * in a syntax-family tint — collapsed to a line budget until ctrl+o.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { FG_DEFAULT } from "#src/core/ansi.ts";
import { detectLanguage } from "#src/theme/highlight.ts";

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
import { type ToolServices } from "./tool-services.ts";

/** Tree connectors: dim rules + the last-entry elbow. */
const TEE = "├── ";
const ELBOW = "└── ";

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
    renderResult: ({ text, palette, theme, ctx, result, options }) => {
      // Inert at intake (ADR 0004): filenames can carry control bytes too.
      // The derivation is memoized on the result object's identity.
      const derive = outputMemoOf(ctx.state);
      const derived = derive(result);
      const { entries } = derived;
      if (entries.length === 0) return renderEmpty(text); // nothing to show — clear any stale task

      // The tree styling runs in the async preview task (the grep/find
      // shape): trigger frames only check the key; the per-entry work
      // (connectors, type coloring) happens off the frame.
      const elapsed = elapsedOf(result) ?? 0;
      // Collapsed up front (grep/find's shape): the placeholder and the
      // fallback never flash or strand the full listing.
      const { shown: shownEntries, tail: plainTail } = collapsedView(entries, {
        budget: COLLAPSED_LINES.ls,
        expanded: options.expanded,
        result,
        theme,
      });
      const plain = `${renderPlainOutput(shownEntries, theme)}${plainTail ? `\n${plainTail}` : ""}`;
      // One computed key serves BOTH roles — ls has no width-dependent
      // layout: the width never joins the key.
      const taskKey = outputTaskKey({
        prefix: "l",
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
          // Render-side collapse (ctrl+o expands) over the tree: the
          // shared collapsedView owns the budget and the affordance+Took
          // tail.
          const { shown, tail } = collapsedView(entries, {
            budget: COLLAPSED_LINES.ls,
            expanded: options.expanded,
            result,
            theme,
          });

          // Tree rendering: one entry per row under a connector rule;
          // type coloring as before (directories accent, code tinted).
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
              return `${connector}${palette.fgCode}${entry}${FG_DEFAULT}`;
            }
            return `${connector}${theme.fg("toolOutput", entry)}`;
          });

          // One blank line separates the footer from the tree (the
          // collapse affordance/Took row is a footer, not a tree row).
          return tail ? `${rows.join("\n")}\n\n${tail}` : rows.join("\n");
        },
      });
      return text;
    },
  });
}
