/**
 * The write tool wrapper: delegates execution to the SDK's write tool (via
 * the tool-wrapper factory), stashes the old/new diff in `result.details`
 * (the one field the TUI preserves), and renders the create preview in the
 * result slot with Shiki highlighting — result summaries (✓/stats) live
 * in the call header's suffix, bridged through render state.
 */

import { existsSync, readFileSync } from "node:fs";

import type {
  AgentToolResult,
  ToolDefinition,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import { inertText } from "#src/core/ansi.ts";
import { type ParsedDiff, parseDiff } from "#src/core/diff.ts";
import { fnv1a } from "#src/core/fingerprint.ts";
import { countLines, textBeforeLine } from "#src/core/lines.ts";
import { detectLanguage, hlBlock } from "#src/theme/highlight.ts";
import { resolveDiffPalette, type DiffPalette, type PaletteTheme } from "#src/theme/palette.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

import { setCallHeader } from "./error-frame.ts";
import { clearToolHeaderBg, padDiffBody, summarize, resultLine } from "./header.ts";
import { borderBar, diffRowFrame, gutterWidth, injectBg, wrapAnsi } from "./render-shared.ts";
import { attachPreviewTask, renderEmpty, setDiffPreviewTask } from "./text-task.ts";
import { createToolWrapper, renderPlainTextFallback } from "./tool-factory.ts";
import { COLLAPSED_LINES, collapsedView, taskKeyOf } from "./tool-output.ts";
import {
  argsSettled,
  callStateOf,
  type ToolServices,
  type WriteState,
  argsOf,
} from "./tool-services.ts";

/**
 * The `result.details` shapes execute() stashes for renderResult(). Kept
 * minimal — details persist into the session JSONL, so every field here is
 * one renderResult actually reads. (One exception rides along: the
 * factory's pigmentElapsedMs timing sideband, stamped on every result —
 * write/edit never read it, but the uniform stamp is the contract the
 * grep/find/ls footers rely on.)
 */
type WriteResultDetails =
  | {
      /** Discriminator: the file changed, render the diff. */
      kind: "diff";
      /** The parsed old/new diff. */
      diff: ParsedDiff;
      /** The Shiki language for highlighting. */
      language: BundledLanguage | undefined;
    }
  | {
      /** Discriminator: a new file was created, render the content preview. */
      kind: "new";
      /**
       * The file's path (language detection + preview cache key). The
       * content itself is derived from `ctx.args` at render time — it is
       * already persisted once in the call arguments, so details must not
       * duplicate it into the session JSONL.
       */
      filePath: string;
    }
  | {
      /** Discriminator: content identical, render the no-change notice. */
      kind: "noChange";
    };

/** Show at most this many diff lines in a write result. */
const MAX_RENDER_LINES = 150;

/** The newFileBody inputs. */
interface NewFileBodyOptions {
  /** The highlighted (or plain) file lines. */
  lines: readonly string[];
  /** The resolved palette. */
  palette: DiffPalette;
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
  const { lines, palette, indicatorGlyph, width } = options;
  const numberWidth = Math.max(2, String(lines.length).length);
  const gutter = gutterWidth(numberWidth, indicatorGlyph);
  const codeWidth = Math.max(20, width - gutter);
  return lines
    .flatMap((line, i) => {
      const frame = diffRowFrame({
        type: "add",
        number: i + 1,
        numberWidth,
        palette,
        indicatorGlyph,
      });
      // Unlimited wrap budget: the file PREVIEW must show its content
      // (the diff views' narrow-terminal row cap truncates overlong
      // lines behind a › marker).
      const wrapped = wrapAnsi(injectBg(line, { baseBg: frame.codeBg, palette }), {
        width: codeWidth,
        maxRows: Number.POSITIVE_INFINITY,
        fillBg: frame.codeBg,
        palette,
      });
      const rows = [`${frame.gutter}${wrapped[0]}${palette.rowReset}`];
      for (let rowIndex = 1; rowIndex < wrapped.length; rowIndex++) {
        rows.push(`${frame.continuation}${wrapped[rowIndex]}${palette.rowReset}`);
      }
      return rows;
    })
    .join("\n");
}

/**
 * The bridged result-summary segment for the call header: which of
 * write's three outcomes renderResult recorded, in priority order
 * (execute stashes exactly one kind, so the order only matters for
 * restored or stale states).
 *
 * @param state - The write wrapper's render state.
 * @param theme - The pi theme.
 * @param palette - The resolved palette.
 * @returns The styled summary segment, or "" when nothing landed yet.
 */
function writeSummarySegment(state: WriteState, theme: PaletteTheme, palette: DiffPalette): string {
  if (state.noChange) return theme.fg("success", "✓ no changes");
  if (state.newFileLines !== undefined) {
    return theme.fg("success", `✓ new file (${state.newFileLines} lines)`);
  }
  if (state.added !== undefined && state.removed !== undefined) {
    return summarize(state.added, state.removed, palette);
  }
  return "";
}

/**
 * Build the write wrapper around `origWrite`: execute delegates and stashes
 * the diff; renderCall/renderResult render with Shiki highlighting.
 *
 * @param origWrite - The SDK write tool to wrap.
 * @param services - Assembly services (cwd, shortPath, indicatorStyle, textFactory).
 * @returns The wrapped tool, ready for pi.registerTool.
 */
export function createWriteWrapper(
  origWrite: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  const { shortPath, indicatorStyle } = services;
  return createToolWrapper<WriteState>(origWrite, services, {
    renderShell: "default",
    // Delegate to the SDK write tool, then stash the old/new diff (or the
    // new-file/no-change marker) in `result.details` for renderResult.
    execute: async (tid, params, sig, upd, ctx) => {
      const wp = argsOf<WriteToolInput>(params);
      const fp = wp.path ?? "";
      // The pre-read runs OUTSIDE the SDK's per-file mutation queue —
      // origWrite.execute queues itself internally, and the
      // queue is a non-reentrant promise chain: wrapping (read + delegate)
      // in withFileMutationQueue deadlock-depends on our own release (all
      // write tests hang). The residual race — a sibling write to the same
      // path landing between our read and the SDK's queued write — is
      // display-only (a preview that momentarily shows a state that never
      // existed) and self-heals on the next render.
      let old: string | null = null;
      try {
        if (fp && existsSync(fp)) old = readFileSync(fp, "utf-8");
      } catch {
        old = null;
      }

      // The SDK's execute returns AgentToolResult<unknown>; the details we
      // stash below make it this shape — the cast is our view of it.
      const result = (await origWrite.execute(
        tid,
        wp,
        sig,
        upd,
        ctx,
      )) as AgentToolResult<WriteResultDetails>;
      const content = wp.content ?? "";

      // Store in details — the only custom field TUI preserves in renderResult
      if (old !== null && old !== content) {
        const diff = parseDiff(old, content, 3);
        const lg = detectLanguage(fp);
        result.details = {
          kind: "diff",
          diff,
          language: lg,
        };
      } else if (old === null) {
        result.details = {
          kind: "new",
          filePath: fp,
        };
      } else if (old === content) {
        result.details = { kind: "noChange" };
      }
      return result;
    },

    // Render the in-flight call header: "← write/← create" + path + the
    // streaming line count. The content preview is the result render's
    // (every wrapper's shape: call = header/feedback, result = content).
    renderCall: ({ text, theme, ctx, renderArgs }) => {
      const callArgs = argsOf<WriteToolInput>(renderArgs);
      const fp = callArgs.path ?? "";
      // Cache the existence probe per path in the render state — renderCall
      // fires every frame, and a sync FS call per frame is waste. The state
      // outlives frames within one tool call (pi's contract).
      ctx.state.existsProbes ??= {};
      if (ctx.state.existsProbes[fp] === undefined) {
        let exists = false;
        try {
          exists = !!fp && existsSync(fp);
        } catch {
          exists = false;
        }
        ctx.state.existsProbes[fp] = exists;
      }
      const isNew = !ctx.state.existsProbes[fp];
      const label = isNew ? "create" : "write";
      const palette = resolveDiffPalette(theme);
      // The result-summary suffix grammar (one position, the header's
      // tail — every wrapper's summaries live here, the result slot
      // carries only content): streaming counts while args grow, then the
      // bridged result summary once renderResult stashes it.
      const summary = writeSummarySegment(ctx.state, theme, palette);
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
        theme,
        suffix,
        pathShortener: shortPath,
        cwd: ctx.cwd,
        status: callStateOf(ctx),
        palette,
      });
      return text;
    },

    // Render the finished call: the diff preview (async task), the new-file
    // preview, the no-change notice, or a plain fallback.
    renderResult: ({ text, palette, theme, ctx, result, options }) => {
      const { details: d } = result as { details: WriteResultDetails | undefined };
      if (d?.kind === "diff") {
        // The stats bridge (the edit wrapper's shape): the call header
        // re-renders on every updateDisplay and picks these up for its
        // "+N −M" suffix on the next frame.
        ctx.state.added = d.diff.added;
        ctx.state.removed = d.diff.removed;
        // The seed source for embedded grammars (vue/html): the NEW file's
        // text before the hunk, sliced from args (which persist into
        // renderResult — live and restored alike). The split lives INSIDE
        // the callback — it runs only when the task's keyed render asks
        // for a seed, never per frame.
        const newContent = argsOf<WriteToolInput>(ctx.args).content ?? "";
        const seedFor = (start: number): string | undefined => textBeforeLine(newContent, start);
        setDiffPreviewTask({
          text,
          keyPrefix: "wd",
          diff: d.diff,
          language: d.language,
          maxLines: MAX_RENDER_LINES,
          palette,
          theme,
          ctx,
          indicatorStyle,
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
        // Inert at intake (ADR 0004): model-authored content gets the same
        // neutralization as file reads before highlighting/wrapping see
        // it. The inert pass + line count live INSIDE the keyed render
        // below — a trigger frame (expand, invalidate) pays nothing.
        const rawArgs = argsOf<WriteToolInput>(ctx.args).content ?? "";
        const lineCount = rawArgs ? countLines(rawArgs) : 0;
        const rawContent = (): string => inertText(rawArgs);
        // The ✓ summary bridges to the header suffix (the next call render
        // picks it up); the result slot below carries ONLY the content
        // preview — one summary position across every wrapper.
        ctx.state.newFileLines = lineCount;
        clearToolHeaderBg(text);
        // The identity = the width-neutral input stamp (the attach guard
        // compares it — the old newFileKey state field retired); the
        // WIDTH joins the task key only: the body pre-wraps per render
        // width, so a resize must re-render. The content fingerprint
        // seals the key (a same-path same-lineCount rewrite must
        // re-render; within one call args are frozen, so it never fires —
        // cheap insurance against a stale memo).
        const identity = taskKeyOf("nf", [
          fp,
          palette.identity,
          lineCount,
          fnv1a(rawArgs),
          options.expanded ? "x" : "c",
        ]);
        const lg = detectLanguage(fp);
        attachPreviewTask(text, {
          identity,
          placeholder: padDiffBody(theme.fg("muted", "rendering file…"), palette),
          fallback: "",
          invalidate: ctx.invalidate,
          key: (width: number) => `${identity}\u0000${width}`,
          render: async (width: number) => {
            const content = rawContent();
            if (!content) return "";
            const hlLines = await hlBlock({
              code: content,
              language: lg,
              palette,
              piTheme: theme,
            });
            // The shared window authority: the collapsed budget AND the
            // expanded cap (MAX_RENDER_LINES) flow through one call, one
            // tail grammar (write shows no Took footer — the SDK's own
            // write renderer never did either).
            const { shown, tail } = collapsedView(hlLines, {
              budget: COLLAPSED_LINES.write,
              expanded: options.expanded,
              expandedCap: MAX_RENDER_LINES,
              theme,
            });
            return `${padDiffBody(
              newFileBody({
                lines: shown,
                palette,
                indicatorGlyph: borderBar(indicatorStyle),
                width,
              }),
              palette,
            )}${tail ? `\n${tail}` : ""}`;
          },
        });
        return text;
      }

      // Unknown details (unreachable through our execute): the shared
      // plain-text fallback (stale task cleared, dim first text).
      return renderPlainTextFallback(text, theme, result);
    },
  });
}
