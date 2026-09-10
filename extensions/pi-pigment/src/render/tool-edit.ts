/**
 * The edit tool wrapper: delegates execution to the SDK's edit tool verbatim
 * (its own normalized-matching rejects ambiguous and overlapping edits) with
 * ZERO result mutation — `result.details` keeps the SDK's own shape
 * ({@link EditToolDetails}: diff, patch, firstChangedLine), so sessions
 * render identically with or without pi-pigment. renderResult lazily parses
 * the stashed `patch` into our ParsedDiff for split-view previews with
 * Shiki highlighting.
 */

import { readFileSync, statSync } from "node:fs";

import type {
  AgentToolResult,
  EditToolDetails,
  EditToolInput,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { parsePatchFiles } from "#src/core/diff.ts";
import { linesBefore, linesOf } from "#src/core/lines.ts";
import { detectLanguage } from "#src/theme/highlight.ts";
import { resolveDiffPalette, type DiffPalette, type PaletteTheme } from "#src/theme/palette.ts";

import { setCallHeader } from "./error-frame.ts";
import { summarize, resultLine } from "./header.ts";
import { setDiffPreviewTask } from "./text-task.ts";
import { createToolWrapper, renderPlainTextFallback } from "./tool-factory.ts";
import {
  argsOf,
  callStateOf,
  resultStreaming,
  type EditState,
  type ToolServices,
} from "./tool-services.ts";

/** Show at most this many diff lines in an edit preview. */
const MAX_PREVIEW_LINES = 60;

/**
 * The muted "(N diff lines)" suffix for edit stats.
 *
 * @param diffLineCount - The diff line count (skipped when not a number).
 * @param theme - The active pi theme.
 * @returns The styled suffix, or "".
 */
function diffLineCountLabel(diffLineCount: unknown, theme: PaletteTheme): string {
  if (typeof diffLineCount !== "number") return "";
  return ` ${theme.fg("muted", `(${diffLineCount} diff lines)`)}`;
}

/**
 * Build the edit wrapper around `origEdit`: execute delegates verbatim (the
 * SDK's edit tool already rejects ambiguous/overlapping edits by throwing —
 * the harness converts throws into error results our error frame renders)
 * with zero result mutation; renderResult parses the SDK's own stashed
 * patch and renders the split view.
 *
 * @param origEdit - The SDK edit tool to wrap (cwd already bound).
 * @param services - Assembly services (shortPath, indicatorStyle, textFactory).
 * @returns The wrapped tool, ready for pi.registerTool.
 */
export function createEditWrapper(
  origEdit: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  const { shortPath, indicatorStyle } = services;

  /**
   * The "N edits (M diff lines)" label for edit stats.
   *
   * @param edits - Number of edit operations.
   * @param diffLines - Total diff lines.
   * @param theme - The active pi theme.
   * @returns The styled label.
   */
  function editEditsCountLabel(edits: number, diffLines: number, theme: PaletteTheme): string {
    const n = edits === 1 ? "1 edit" : `${edits} edits`;
    return `${n}${diffLineCountLabel(diffLines, theme)}`;
  }

  /**
   * The `N edits (+M diff lines) +A -D` stats suffix for an edit header,
   * from the state bridge (renderResult stashed the counts from result
   * details + args).
   *
   * @param state - The edit render state.
   * @param theme - The active pi theme.
   * @param palette - The resolved palette (summarize colors).
   * @returns The styled suffix, or "" when no stats exist.
   */
  function editCallStatsSuffix(
    state: EditState,
    theme: PaletteTheme,
    palette: DiffPalette,
  ): string {
    if (state.editCount === undefined || state.diffLines === undefined) return "";
    const count = editEditsCountLabel(state.editCount, state.diffLines, theme);
    return resultLine(
      theme.fg("muted", count),
      summarize(state.added ?? 0, state.removed ?? 0, palette),
    );
  }

  // Execution delegates verbatim (the factory's default path): the SDK's
  // details shape (diff, patch, firstChangedLine) persists into the
  // session JSONL untouched (one exception rides along on every result —
  // the factory's pigmentElapsedMs timing sideband; edit never reads it,
  // but the uniform stamp is the contract the grep/find/ls Took footers
  // rely on), so the NATIVE renderer still works on
  // pi-pigment-created sessions resumed without pi-pigment, and renderResult
  // below parses the stashed patch lazily. Errors never reach here as
  // results — the SDK edit tool throws, and the harness converts throws
  // into error results rendered by the factory's error frame.
  // The wrapper claims the DEFAULT shell explicitly: the SDK edit
  // definition declares renderShell "self" (its call component is its
  // own Box with a bgFn it flips on errors), but ours renders plain Text
  // frame pieces — the default shell's content Box then owns the frame's
  // background (success for live frames, ERROR for failed ones, painted
  // across every row INCLUDING the blanks and the Took footer) and the
  // 1-column padding. A self shell here would leave those rows bare.
  return createToolWrapper<EditState>(origEdit, services, {
    // Render the in-flight call header: "← edit" + path + stats, framed
    // once the edit arguments complete.
    renderCall: ({ text, theme, ctx, renderArgs }) => {
      const callArgs = argsOf<EditToolInput>(renderArgs);
      const fp = callArgs.path ?? "";
      const palette = resolveDiffPalette(theme);

      // Pre-bridge (streaming) the stats are "" — the same header as the
      // suffix-less shape, so one call serves both frames.
      const stats = editCallStatsSuffix(ctx.state, theme, palette);
      // The header row's background follows the call's outcome (the
      // shared setCallHeader home — the default shell's content Box
      // already paints its own error bg, but the header Text's custom bg
      // composes OVER the Box bg on its rows; the flip keeps the row
      // consistent with an all-error frame).
      setCallHeader(text, {
        label: "edit",
        filePath: fp,
        theme,
        suffix: stats,
        pathShortener: shortPath,
        cwd: ctx.cwd,
        status: callStateOf(ctx),
        palette,
      });
      return text;
    },

    renderResult: ({ text, palette, theme, ctx, result }) => {
      // Lazily adapt the SDK's own stashed patch (the text it actually
      // matched) into our ParsedDiff — parse on render, not execute, so
      // result.details stays byte-identical to the native tool's (ADR
      // 0005: sessions must render identically with or without pi-pigment).
      const details = (result as AgentToolResult<EditToolDetails>).details;
      // Parse memo (the seedCache shape): the patch is frozen once the
      // result lands, and renderResult re-runs on every updateDisplay —
      // the parse is keyed by patch identity in the render state, not
      // repeated per frame. details stays untouched (ADR 0005).
      let diffMemo = ctx.state.parsedDiff;
      if (!diffMemo || diffMemo.patch !== details?.patch) {
        const parsed = details?.patch ? parsePatchFiles(details.patch)[0] : undefined;
        diffMemo = {
          patch: details?.patch,
          diff: parsed && parsed.added + parsed.removed > 0 ? parsed : undefined,
        };
        ctx.state.parsedDiff = diffMemo;
      }
      const diff = diffMemo.diff;
      if (diff) {
        // The settled args (present at every render, live and restored
        // alike) — cast once, read everywhere below.
        const callArgs = argsOf<EditToolInput>(ctx.args);
        const editPath = callArgs.path ?? "";
        // The language comes from args, which persist alongside details.
        const language = detectLanguage(editPath);
        // Bridge the stats for the call header: the diff counts live in
        // details, the edit-op count in args (both present at result
        // time); the call header renders on every update — this render's
        // stash is the next header's suffix. Restored sessions get it too
        // (details and args both persist).
        // || 1: a count of zero (partial args mid-stream, or all edits
        // no-ops) reads wrong on the header — one is the honest floor.
        ctx.state.editCount = getEditOperations(callArgs).length || 1;
        ctx.state.diffLines = diff.lines.length;
        ctx.state.added = diff.added;
        ctx.state.removed = diff.removed;
        // The seed source for embedded grammars (vue/html): the post-edit
        // file from disk (the edit already applied — the file IS the new
        // text). Cached per path+mtime inside the state: the render closure
        // runs on every frame, and a disk read per frame is not free.
        const seedFor = (start: number): string | undefined => {
          if (start <= 1 || !editPath) return undefined;
          let cached = ctx.state.seedCache;
          try {
            const st = statSync(editPath);
            if (!cached || cached.path !== editPath || cached.mtimeMs !== st.mtimeMs) {
              cached = {
                path: editPath,
                mtimeMs: st.mtimeMs,
                lines: linesOf(readFileSync(editPath, "utf-8")),
              };
              ctx.state.seedCache = cached;
            }
          } catch {
            return undefined; // unreadable file: render unseeded
          }
          return linesBefore(cached.lines, start);
        };
        setDiffPreviewTask({
          text,
          keyPrefix: "ed",
          diff,
          language,
          maxLines: MAX_PREVIEW_LINES,
          palette,
          theme,
          ctx,
          indicatorStyle,
          seedFor,
          // Result growth from the three-state model (pending = streaming)
          // — the same gate every preview path shares.
          streaming: resultStreaming(ctx),
        });
        return text;
      }
      return renderPlainTextFallback(text, theme, result);
    },
    renderShell: "default",
  });
}

/** One non-empty, non-identical edit pair from the SDK's `edits[]` shape. */
interface EditOperation {
  /** The text to replace. */
  oldText: string;
  /** The replacement text. */
  newText: string;
}

/**
 * Extract the edit operations from the SDK's `edits[]` shape.
 *
 * @param input - The tool call's arguments.
 * @returns The non-empty, non-identical edit pairs.
 */
function getEditOperations(input: Partial<EditToolInput>): EditOperation[] {
  return (input?.edits ?? [])
    .map((edit: { oldText?: string; newText?: string }) => ({
      oldText: typeof edit?.oldText === "string" ? edit.oldText : "",
      newText: typeof edit?.newText === "string" ? edit.newText : "",
    }))
    .filter((edit) => edit.oldText && edit.oldText !== edit.newText);
}
