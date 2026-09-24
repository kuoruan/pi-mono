/**
 * Header ellipsis: middle-cut truncation for single-line call headers.
 * Pure fitting (ellipsizeMiddle/fitHeaderLine) plus the width-task
 * attach (renderHeaderLine) — the attach half lives on the render side
 * (text-task, term), only the fitting half is core-pure.
 */

import { forEachCell, measurePlain } from "#src/core/ansi.ts";
import { SEQ_BOLD_OFF, SEQ_ESC, SEQ_FG_DEFAULT, SEQ_RESET_BARE } from "#src/core/escapes.ts";

import type { RenderView } from "./session.ts";
import { termW } from "./term.ts";
import type { PreviewTextHost } from "./text-task.ts";
import { attachPreviewTask, clearPreviewTask, definePreviewTask } from "./text-task.ts";
import type { RenderContext, ToolServices } from "./tool-services.ts";

/** The single-char ellipsis (one column; the TUI is Unicode-safe). */
const ELLIPSIS = "…";
/** The newline fold marker (with trailing breathing room). */
const FOLD = "⏎ ";

/** The cut markers' shapes: muted styling lands in renderHeaderLine (the one place with a theme). */
export interface EllipsisMarks {
  /** The middle-cut marker (one column). */
  ellipsis: string;
  /** The newline fold marker (with trailing breathing room). */
  fold: string;
}

/** Bare markers (the pure functions' default — tests read shapes, not colors). */
const BARE_MARKS: EllipsisMarks = { ellipsis: ELLIPSIS, fold: FOLD };

/**
 * Truncate styled text to fit a width, cutting the MIDDLE: head + … +
 * tail. Both ends survive (paths/commands carry information at both
 * ends); the cut lands on cell boundaries, so wide characters never
 * split. SGR state open at the cut reopens on the tail; the head closes
 * fg + bold only (NEVER a bare reset — the row background lives outside
 * these sequences and a reset would cut it off mid-row).
 *
 * @param styled - The ANSI-styled line.
 * @param width - The visual column budget.
 * @param marks - The cut markers (bare by default; muted in headers).
 * @returns The fitted line (untouched when it already fits).
 */
export function ellipsizeMiddle(styled: string, width: number, marks = BARE_MARKS): string {
  // Multi-line input (a heredoc command) folds to one visual row first:
  // the newline becomes a bare ⏎ (the width task's muted styling lands
  // in renderHeaderLine, the one place that owns a theme).
  const flat = styled.replaceAll("\n", marks.fold);
  if (measurePlain(flat) <= width) return flat;
  const ellipsisCols = measurePlain(marks.ellipsis);
  const headBudget = Math.floor((width - ellipsisCols) / 2);
  const tailBudget = width - ellipsisCols - headBudget;
  if (headBudget <= 0 || tailBudget <= 0) return marks.ellipsis;
  // Head: the first headBudget columns, tracking open SGR sequences.
  const opens: Array<string> = [];
  let headCols = 0;
  let headEnd = 0;
  forEachCell(flat, (start, end, cols, isEscape) => {
    if (isEscape) {
      const seq = flat.slice(start, end);
      if (seq === SEQ_RESET_BARE) opens.length = 0;
      else if (seq === SEQ_FG_DEFAULT) {
        const i = opens.findLastIndex((s) => s.startsWith(`${SEQ_ESC}[38;`));
        if (i !== -1) opens.splice(i, 1);
      } else if (seq === SEQ_BOLD_OFF) {
        const i = opens.findLastIndex((s) => s.includes("[1m"));
        if (i !== -1) opens.splice(i, 1);
      } else opens.push(seq);
      return;
    }
    if (headCols + cols > headBudget) return true;
    headCols += cols;
    headEnd = end;
  });
  // Tail: the last tailBudget columns (a second walk from the end is
  // cheapest via full-walk recording — headers are short).
  const cells: Array<{ start: number; end: number; cols: number; isEscape: boolean }> = [];
  forEachCell(flat, (start, end, cols, isEscape) => {
    cells.push({ start, end, cols, isEscape });
  });
  let tailCols = 0;
  let tailStart = flat.length;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (c.isEscape) {
      tailStart = c.start;
      continue;
    }
    if (tailCols + c.cols > tailBudget) break;
    tailCols += c.cols;
    tailStart = c.start;
  }
  // Escapes between headEnd and tailStart are dropped; the tail reopens
  // whatever the head left open. The head closes fg/bold only — the
  // ellipsis carries its own style, the row background flows through.
  return `${flat.slice(0, headEnd)}${SEQ_FG_DEFAULT}${SEQ_BOLD_OFF}${marks.ellipsis}${opens.join("")}${flat.slice(tailStart)}`;
}

/**
 * Fit a header line (body + pinned suffix) to a width: the suffix never
 * enters the ellipsis budget — state must survive truncation. Undefined
 * width means expanded (the full line; soft-wrap is the TUI's business).
 *
 * @param body - The styled header body.
 * @param suffix - The pinned status suffix (may be "").
 * @param width - The visual column budget, or undefined for full.
 * @param marks - The cut markers (bare by default; muted in headers).
 * @returns The fitted line.
 */
export function fitHeaderLine(
  body: string,
  suffix: string,
  width: number | undefined,
  marks = BARE_MARKS,
): string {
  if (width === undefined) return `${body}${suffix}`;
  const suffixWidth = measurePlain(suffix);
  const bodyBudget = Math.max(0, width - suffixWidth);
  return `${ellipsizeMiddle(body, bodyBudget, marks)}${suffix}`;
}

/**
 * A call header task's inputs — the call-varying parts (body/suffix/
 * newline/prefix) plus the frame's own view/ctx/services, which fill the
 * mechanical fields (ellipsis switch, expand state, palette identity,
 * theme, invalidate). One shape behind all five header sites; the stamp
 * list must cover the render closure.
 */
export interface HeaderParts {
  /** The width-aware host. */
  text: PreviewTextHost;
  /** The task key prefix (per tool). */
  prefix: string;
  /** The frame's derived view (palette + pi theme). */
  view: RenderView;
  /** The render context (expand state + invalidate). */
  ctx: RenderContext<object>;
  /** The injected services (the ellipsis switch). */
  services: ToolServices;
  /** The styled header body (the ellipsis budget applies here only). */
  body: string;
  /** The pinned suffix (never truncated). */
  suffix?: string;
  /** The header's trailing newline (grep/find/ls own theirs). */
  newline?: string;
}

/**
 * Attach a call header task: off means always-full setText (clearing
 * any stale task — the host is reused across frames); on attaches a
 * width-aware task whose stamps cover every render input (body, suffix,
 * the expanded bit for ctrl+o refit, the palette).
 *
 * @param parts - The header task's inputs.
 */
export function renderHeaderLine(parts: HeaderParts): void {
  const { text, prefix, view, ctx, services, body, suffix = "", newline = "\n" } = parts;
  const { palette, piTheme: theme } = view;
  // Both marks are muted chrome (the theme owns the slot): the ellipsis
  // breathes in spaces, the fold mark trails one (no glyph crowding).
  const marks: EllipsisMarks = {
    ellipsis: theme.fg("muted", ELLIPSIS),
    fold: theme.fg("muted", FOLD),
  };
  const full = `${body}${suffix}${newline}`;
  if (services.headerEllipsis === "off") {
    clearPreviewTask(text);
    text.setText(full);
    return;
  }
  const fit = (w: number | undefined): string =>
    `${fitHeaderLine(body, suffix, w, marks)}${newline}`;
  attachPreviewTask(
    text,
    definePreviewTask({
      prefix,
      // The trailing blank follows the call state (pending headers own
      // none) — without it a pending→error transition keeps the
      // blank-less frame and glues the header to the body below.
      stamps: [body, suffix, ctx.expanded ? 1 : 0, palette.identity, newline],
      widthAware: true,
      placeholder: fit(termW()),
      fallback: full,
      invalidate: ctx.invalidate,
      render: (w) => Promise.resolve(fit(ctx.expanded ? undefined : w)),
    }),
  );
}
