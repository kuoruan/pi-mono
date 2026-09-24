/**
 * The output-assembly module: the three SDK-delegated output tools'
 * (grep/find/ls) shared result-body choreography — the empty guard, the
 * swap key, the settled-frame shortcut, the windowed plain body (header
 * gap + plain rows + tail), and the preview-task attach. It sits beside
 * tool-output (the window authority) and text-task (the swap protocol),
 * importing from both — neither imports it back, so no cycle.
 */
import type { PaletteTheme } from "#src/theme/scheme.ts";

import type { PreviewTextHost } from "./text-task.ts";
import { attachPreviewTask, definePreviewTask, renderEmpty } from "./text-task.ts";
import {
  collapsedView,
  type DerivedOutput,
  joinBodyTail,
  outputTaskKey,
  renderPlainOutput,
} from "./tool-output.ts";

/** The output-assembly inputs — the three SDK-delegated output tools' shared shape. */
export interface OutputAssemblyInput {
  /** The host Text component (guard reads + task attach land here). */
  text: PreviewTextHost;
  /** The key prefix ("g"/"f"/"l" — the tool's stamp namespace). */
  prefix: string;
  /** The derived full line list (the window slices it). */
  lines: string[];
  /** The empty verdict (grep: blank output; find/ls: no entries) — the guard clears any stale task. */
  isEmpty: boolean;
  /** The collapsed budget (grep 15, find/ls 20). */
  budget: number;
  /** The memoized derivation (key stamps read it). */
  derived: DerivedOutput;
  /** The scheme identity (a theme switch re-renders). */
  paletteIdentity: string;
  /** The raw Took reading (undefined → no footer; the key reads tookMs ?? 0). */
  tookMs?: number;
  /** The expanded state (window regime + key stamp). */
  expanded: boolean;
  /** The streaming stamp (grep only — pending frames render plain). */
  streaming?: boolean;
  /** The limit notice (the SDK's warning about the whole output). */
  notice?: string;
  /** The pi theme. */
  theme: PaletteTheme;
  /** The render context (invalidate flows into the task). */
  ctx: { invalidate: () => void };
  /** The styled swap: shown lines + tail + hidden → the settled body. */
  renderStyled: (shown: string[], tail: string, hidden: number) => string | Promise<string>;
}

/**
 * Assemble an SDK-delegated output tool's result body: the empty guard,
 * the swap key, the settled-frame shortcut, the windowed plain body, and
 * the preview-task attach. The
 * wrappers supply only what varies (prefix, budget, notice, the styled
 * callback); the guard order and the key stamps live here once — a
 * fourth output tool cannot forget a stamp.
 *
 * @param input - The assembly inputs (see OutputAssemblyInput).
 * @returns The host text (the factory's renderResult return).
 */
export function assembleOutputBody(input: OutputAssemblyInput): PreviewTextHost {
  const {
    text,
    prefix,
    lines,
    isEmpty,
    budget,
    derived,
    paletteIdentity,
    expanded,
    streaming,
    notice,
    theme,
    ctx,
    renderStyled,
    tookMs,
  } = input;
  if (isEmpty) return renderEmpty(text); // nothing to show — clear any stale task
  const taskKey = outputTaskKey({
    prefix,
    derived,
    identity: paletteIdentity,
    elapsedMs: tookMs ?? 0,
    expanded,
    streaming,
  });
  // The settled-frame shortcut: an unchanged identity means the attach
  // guard below would discard the window/plain work this frame is about
  // to build. Positioned after the empty guard, before any of it.
  if (text.previewIdentity === taskKey && text.previewTask) return text;
  const { shown, tail, hidden } = collapsedView(lines, {
    budget,
    expanded,
    tookMs,
    notice,
    theme,
  });
  const plain = joinBodyTail(renderPlainOutput(shown, theme), tail, hidden);
  attachPreviewTask(
    text,
    definePreviewTask({
      identity: taskKey,
      widthAware: false,
      placeholder: plain,
      fallback: plain,
      invalidate: ctx.invalidate,
      render: async () => renderStyled(shown, tail, hidden),
    }),
  );
  return text;
}
