/**
 * The write renderer: pi's own write tool executes; the old/new diff rides
 * the write details channel (write-details-channel.ts) into
 * `result.details`, and this triple renders the create preview in the
 * result slot with Shiki highlighting — result summaries (✓/stats) live
 * in the call header's suffix, bridged through render state.
 */

import type { ToolRenderers, WriteToolInput } from "@earendil-works/pi-coding-agent";

import { expandTabs, inertText } from "#src/core/ansi.ts";
import { fnv1a } from "#src/core/keys.ts";
import { countLines, linesOf } from "#src/core/lines.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { ResolvedTheme, RenderTheme } from "#src/theme/scheme.ts";
import { seedFromText } from "#src/theme/seed.ts";

import { setCallHeader } from "./error-frame.ts";
import { clearToolHeaderBg, padDiffBody, summarize, resultLine } from "./header.ts";
import { decorativeExists, resolveToolPath } from "./paths.ts";
import { borderBar, gutterWidth, numberedRows } from "./row-frame.ts";
import {
  attachDiffPreview,
  attachPreviewTask,
  definePreviewTask,
  renderEmpty,
} from "./text-task.ts";
import { createToolRenderer, renderPlainTextFallback } from "./tool-factory.ts";
import { COLLAPSED_LINES, collapsedView, joinBodyTail, newFileKey } from "./tool-output.ts";
import {
  argsSettled,
  callStateOf,
  resultStreaming,
  type ToolServices,
  type WriteState,
  argsOf,
} from "./tool-services.ts";
import { type WriteResultDetails } from "./write-details.ts";

/** Show at most this many diff lines in a write result. */
const MAX_RENDER_LINES = 150;

/** The newFileBody inputs. */
interface NewFileBodyOptions {
  /** The highlighted (or plain) file lines. */
  lines: readonly string[];
  /** The resolved scheme. */
  scheme: ResolvedTheme;
  /** The indicator column's glyph (borderBar's result). */
  indicatorGlyph: string;
  /** The render width in columns (the preview task's width). */
  width: number;
}

/**
 * The new-file preview body: highlighted lines framed as add rows — the
 * same number gutter and change-sign grammar the diff views use, so a
 * created file reads as "all additions" instead of an unnumbered blob.
 * Width-aware: each line pre-wraps to the render width and its
 * continuation rows repeat the gutter shape (the bar over blank
 * number/sign columns) — the TUI's own wrap would leave them bare.
 *
 * @param options - The body's inputs.
 * @returns The framed body.
 */
function newFileBody(options: NewFileBodyOptions): string {
  const { lines, scheme, indicatorGlyph, width } = options;
  const numberWidth = Math.max(2, String(lines.length).length);
  return numberedRows({
    lines,
    scheme,
    type: "add",
    startLine: 1,
    gutter: gutterWidth(numberWidth, indicatorGlyph),
    indicatorGlyph,
    width,
  }).join("\n");
}

/**
 * The bridged result-summary segment for the call header: which of
 * write's three outcomes renderResult recorded, in priority order
 * (the call records exactly one outcome, so the order only matters for
 * restored or stale states).
 *
 * @param state - The write renderer's render state.
 * @param theme - The pi theme.
 * @param scheme - The resolved scheme.
 * @returns The styled summary segment, or "" when nothing landed yet.
 */
function writeSummarySegment(state: WriteState, theme: RenderTheme, scheme: ResolvedTheme): string {
  if (state.noChange) return theme.fg("success", "✓ no changes");
  // The line count lives in the stats memo (the bridge field the header
  // used to read died with it — the memo is set by the SAME renderResult,
  // so the header sees it on the same next frame).
  if (state.newFileStats) {
    return theme.fg("success", `✓ new file (${state.newFileStats.lineCount} lines)`);
  }
  if (state.added !== undefined && state.removed !== undefined) {
    return summarize(state.added, state.removed, scheme);
  }
  return "";
}

/**
 * Build the write renderer around `origWrite`: the old/new diff rides the
 * write-details channel (pi's own write tool executes); renderCall/renderResult
 * render with Shiki highlighting.
 *
 * @param origWrite - The SDK write renderers to delegate to.
 * @param services - Assembly services (cwd, shortPath, indicatorStyle, textFactory).
 * @returns The renderer triple.
 */
export function createWriteRenderer(
  origWrite: ToolRenderers | undefined,
  services: ToolServices,
): ToolRenderers {
  const { shortPath, indicatorStyle } = services;
  return createToolRenderer<WriteState>("write", origWrite, services, {
    renderShell: "default",
    // Execution delegates verbatim (the factory's default path): the
    // SDK's write tool stashes `details: undefined`, so the old/new diff
    // the renderer needs is captured by the session's hook pair — see
    // write-details-channel.ts, registered by the extension. The renderer
    // owns no execute.

    // Render the in-flight call header: "← write/← create" + path + the
    // streaming line count. The content preview is the result render's
    // (every renderer's shape: call = header/feedback, result = content).
    renderCall: ({ text, view, ctx, renderArgs }) => {
      const { scheme, theme } = view;
      const callArgs = argsOf<WriteToolInput>(renderArgs);
      const fp = callArgs.path ?? "";
      // Cache the existence probe per path in the render state — renderCall
      // fires every frame, and a sync FS call per frame is waste. The state
      // outlives frames within one tool call (pi's contract).
      ctx.state.existsProbes ??= {};
      if (ctx.state.existsProbes[fp] === undefined) {
        ctx.state.existsProbes[fp] = decorativeExists(resolveToolPath(ctx.cwd, fp));
      }
      const isNew = !ctx.state.existsProbes[fp];
      const label = isNew ? "create" : "write";
      // The result-summary suffix grammar (one position, the header's
      // tail — every renderer's summaries live here, the result slot
      // carries only content): streaming counts while args grow, then the
      // bridged result summary once renderResult stashes it.
      const summary = writeSummarySegment(ctx.state, theme, scheme);
      // While the content argument still streams, its growing line count
      // prefixes the summary (counted without allocating — streaming
      // frames re-run this over the full accumulated content).
      const suffix =
        callArgs.content && !argsSettled(ctx)
          ? resultLine(
              theme.fg("muted", `(${countLines(String(callArgs.content))} lines…)`),
              summary,
            )
          : resultLine(summary);

      setCallHeader(text, {
        label,
        filePath: fp,
        suffix,
        pathShortener: shortPath,
        cwd: ctx.cwd,
        status: callStateOf(ctx),
        view,
        ctx,
        services,
        prefix: "wh",
      });
      return text;
    },

    // Render the finished call: the diff preview (async task), the new-file
    // preview, the no-change notice, or a plain fallback.
    renderResult: ({ text, view, ctx, result, options }) => {
      const { scheme, theme } = view;
      const { details: d } = result as { details: WriteResultDetails | undefined };
      if (d?.kind === "diff") {
        // The stats bridge (the edit renderer's shape): the call header
        // re-renders on every updateDisplay and picks these up for its
        // "+N −M" suffix on the next frame.
        ctx.state.added = d.diff.added;
        ctx.state.removed = d.diff.removed;
        // The seed source for embedded grammars (vue/html), and only for
        // them (the same gate the edit renderer applies): the NEW file's
        // text before the hunk, sliced from args (which persist into
        // renderResult — live and restored alike). The split lives INSIDE
        // the callback — it runs only when the task's keyed render asks
        // for a seed, never per frame. An oversized prefix is dropped in
        // hlBlockResolved, where the tokenize pays for it.
        const newContent = argsOf<WriteToolInput>(ctx.args).content ?? "";
        const seedFor = seedFromText(newContent, d.language);
        attachDiffPreview({
          text,
          keyPrefix: "wd",
          diff: d.diff,
          language: d.language,
          maxLines: MAX_RENDER_LINES,
          view,
          ctx,
          services,
          seedFor,
        });
        return text;
      }
      if (d?.kind === "noChange") {
        // The confirmation lives in the header suffix (bridged; the next
        // call render picks it up). The result slot renders empty — the
        // native write's success shape (an empty Container).
        ctx.state.noChange = true;
        clearToolHeaderBg(text);
        return renderEmpty(text);
      }
      if (d?.kind === "new") {
        const { filePath: fp } = d;
        const rawArgs = argsOf<WriteToolInput>(ctx.args).content ?? "";
        // Stats memo (edit's parsedDiff pattern): renderResult re-runs on
        // every updateDisplay, and settled args are frozen — the content's
        // REFERENCE is stable frame to frame, so the line count and
        // fingerprint scan once per call instead of per frame.
        let stats = ctx.state.newFileStats;
        if (!stats || stats.content !== rawArgs) {
          stats = {
            content: rawArgs,
            lineCount: rawArgs ? countLines(rawArgs) : 0,
            fingerprint: fnv1a(rawArgs),
          };
          ctx.state.newFileStats = stats;
        }
        const lineCount = stats.lineCount;
        // Inert at intake (ADR 0004): model-authored content gets the same
        // neutralization as file reads before highlighting/wrapping see
        // it. The inert pass lives INSIDE the keyed render below — a
        // trigger frame (expand, invalidate) pays nothing.
        const rawContent = (): string => inertText(rawArgs);
        // The ✓ summary bridges to the header suffix (the next call render
        // picks it up); the result slot below carries ONLY the content
        // preview — one summary position across every renderer.
        clearToolHeaderBg(text);
        // newFileKey owns the width-neutral stamp list (the attach guard
        // compares the identity it returns — the old newFileKey state
        // field retired; the content fingerprint seals the key against a
        // same-path same-lineCount rewrite); the WIDTH joins the task key
        // only (widthAware): the body pre-wraps per render width, so a
        // resize must re-render.
        // The pending gate snapshots at attach time (the async render may
        // run after settle — a late read of mutable frame state would
        // revert to the tokenizing path).
        const pending = resultStreaming(ctx);
        const lg = detectLanguage(fp);
        attachPreviewTask(
          text,
          definePreviewTask({
            identity: newFileKey({
              prefix: "nf",
              filePath: fp,
              identity: scheme.identity,
              lineCount,
              fingerprint: stats.fingerprint,
              expanded: options.expanded,
              streaming: pending,
            }),
            widthAware: true,
            placeholder: padDiffBody(theme.fg("muted", "rendering file…"), scheme),
            fallback: "",
            invalidate: ctx.invalidate,
            render: async (width: number) => {
              // Tabs expand BEFORE highlight/wrap (split/unified parity):
              // Shiki keeps tabs inside tokens and the renderer measures a
              // tab as one column, while pi-tui's Text renders it as three
              // spaces — an unexpanded tab makes long indented rows wrap
              // twice (the trailing-bar artifact).
              const content = expandTabs(rawContent());
              if (!content) return "";
              // Streaming frames stay plain (no re-tokenize per partial);
              // the settled frame highlights and populates the cache.
              const bodyLines = pending
                ? linesOf(content)
                : await view.highlight({
                    code: content,
                    language: lg,
                  });
              // The shared window authority: the collapsed budget AND the
              // expanded cap (MAX_RENDER_LINES) flow through one call, one
              // tail grammar (write shows no Took footer — the SDK's own
              // write renderer never did either).
              const { shown, tail, hidden } = collapsedView(bodyLines, {
                budget: COLLAPSED_LINES.write,
                expanded: options.expanded,
                expandedCap: MAX_RENDER_LINES,
                theme,
              });
              return joinBodyTail(
                `${padDiffBody(
                  newFileBody({
                    lines: shown,
                    scheme,
                    indicatorGlyph: borderBar(indicatorStyle),
                    width,
                  }),
                  scheme,
                )}`,
                tail,
                hidden,
              );
            },
          }),
        );
        return text;
      }

      // Unknown details (unreachable through the write-details channel):
      // the shared plain-text fallback (stale task cleared, dim first text).
      return renderPlainTextFallback(text, theme, result);
    },
  });
}
