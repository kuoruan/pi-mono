/**
 * The result-BODY rendering vocabulary: the output memo (identity-keyed
 * derive), the collapsed-view window authority
 * (CONTEXT.md: one window concept, the budgets + tail grammar), and the
 * execution clock the Took footer reads. The TUI contract (render
 * context, per-tool states) and the assembly inputs stay in
 * tool-services; wrappers import their slice by intent — a wrapper's
 * import list reads as its contract.
 */
import type {
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
} from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";

import { inertText } from "#src/core/ansi.ts";
import { fnv1a } from "#src/core/fingerprint.ts";
import { linesOf } from "#src/core/lines.ts";
import type { PaletteTheme } from "#src/theme/palette.ts";

import type { ExecutionTimingState } from "./tool-services.ts";

/**
 * The collapsed-state line budget per tool — the same numbers the SDK's
 * native renderers use (grep 15, find/ls 20, write 10), so pi-pigment's
 * collapsed previews show exactly as much as the built-ins would.
 */
export const COLLAPSED_LINES = { grep: 15, find: 20, ls: 20, write: 10 } as const;

/**
 * The header gap: one blank line between the call header and the result
 * body (the native bash renderer's leading `\\n` — bash.js paints its
 * output body with a leading newline). It lives on the BODY side by
 * necessity, not by design: the SDK's Text component exposes setText
 * but no read-back, so the wrapper cannot append the gap to the native
 * header it doesn't own — the body leads with the gap instead. One
 * constant so the three wrappers (grep/find/ls) can't drift.
 */
export const HEADER_GAP = "\n";

/**
 * Join a body to its tail: the expand hint hugs the body (it is the
 * window's own chrome — "more below"), while a notice/Took-led tail is a
 * footnote and breathes below a blank line. The caller passes hidden
 * (the window's own count — > 0 means the tail leads with the hint).
 *
 * @param body - The rendered body (already carrying HEADER_GAP).
 * @param tail - The collapsedView tail ("" when nothing follows).
 * @param hidden - The window's hidden count.
 * @returns The joined block.
 */
export function joinBodyTail(body: string, tail: string, hidden: number): string {
  if (!tail) return body;
  return `${body}${hidden > 0 ? "\n" : "\n\n"}${tail}`;
}

/**
 * The tail a windowed body appends — one shape across tools, so the
 * affordance reads uniformly: the collapsed window advertises the expand
 * key (the hint text arrives pre-rendered — the SDK's keyHint resolves
 * the user's actual binding; passing it in keeps this module free of the
 * keybinding/theme globals); the expanded cap (write's preview) reports
 * the remainder without an affordance (nothing further to expand into).
 *
 * @param hidden - The number of lines the window is hiding.
 * @param theme - The pi theme (muted fg).
 * @param expandHint - The rendered expand-key hint ("" in the cap regime).
 * @returns The styled tail line, or "" when nothing is hidden.
 */
export function collapseTail(hidden: number, theme: PaletteTheme, expandHint: string): string {
  if (hidden <= 0) return "";
  return expandHint
    ? theme.fg("muted", `... (${hidden} more lines, `) + expandHint + theme.fg("muted", ")")
    : theme.fg("muted", `... (${hidden} more lines)`);
}

/**
 * One result object's derived output views (the memo's value). The
 * per-frame derivation below exists so grep/find/ls don't re-run inert +
 * split + fingerprint over the full output (4 O(n) passes, the render
 * thread) every trigger just to compute the task key: the memo keys on
 * the RESULT OBJECT's identity — the TUI hands renderResult a fresh
 * result object exactly when the content can change (each streaming
 * partial, then the frozen final), so identity is the invalidator and a
 * stable result costs one lookup per frame.
 */
export interface DerivedOutput {
  /** The full inert output text. */
  output: string;
  /** The content lines: empty lines kept (grep's budget unit), the SDK's limit notice excluded. */
  lines: string[];
  /** Non-empty content lines (find/ls: the SDK's path-list shape), the notice excluded. */
  entries: string[];
  /**
   * The SDK's bracketed limit notice ("[1000 results limit reached. …]")
   * when the result carries one, else "". Lifted out of the content so no
   * renderer shows it as a hit, path or tree row; collapsedView paints it
   * as the warning footer.
   */
  notice: string;
  /** The content fingerprint (the swap key's identity component). */
  hash: string;
}

/**
 * The limit flags the SDK's grep/find/ls details carry — one shape built
 * from the three tools' own details types (all SDK exports), so a flag
 * rename upstream moves with it: exactly the fields pi's native
 * renderers read.
 */
type LimitFlags = Pick<GrepToolDetails, "truncation" | "matchLimitReached" | "linesTruncated"> &
  Pick<FindToolDetails, "resultLimitReached"> &
  Pick<LsToolDetails, "entryLimitReached">;

/** A result object's structural slice for details — the memo's read seam. */
interface ResultDetails {
  details?: unknown;
}

/**
 * The SDK's limit notice, when this result carries one. grep/find/ls append
 * it as the text's LAST non-empty line AND record the same fact in
 * `details` (one code path does both); the structured field is the
 * authority — exactly what pi's native renderers read — and the trailing
 * line supplies the words, never the other way around: a bracketed filename
 * is not a notice, and no text shape can promote one.
 *
 * @param output - The inert output text.
 * @param details - The result's details.
 * @returns The notice line, or "" when the result has none.
 */
function limitNoticeOf(output: string, details: unknown): string {
  const flags = details as LimitFlags | undefined;
  const limited =
    flags !== undefined &&
    (flags.matchLimitReached !== undefined ||
      flags.resultLimitReached !== undefined ||
      flags.entryLimitReached !== undefined ||
      flags.linesTruncated === true ||
      flags.truncation?.truncated === true);
  if (!limited) return "";
  const nonEmpty = linesOf(output).filter((line) => line.length > 0);
  const last = nonEmpty[nonEmpty.length - 1];
  // Keep a notice only when real content precedes it: nothing else can
  // carry the output then (the SDK never emits a notice over an empty
  // result), and the " > 1 " guard keeps the wrapper guards' semantics
  // (an empty body stays empty).
  if (nonEmpty.length < 2 || last === undefined || !last.startsWith("[") || !last.endsWith("]")) {
    return "";
  }
  return last;
}

/**
 * The preview-task key builder — one join authority for every wrapper's
 * cache-key stamps (the factory's error frame, write's new-file preview,
 * the diff previews' base key, and outputTaskKey's internals). NUL-joined:
 * ":"-joined stamps collide (Unix paths may contain colons, Windows drive
 * letters always do), and NUL cannot appear in any stamp we pass. Serves
 * BOTH the width-neutral identity (the attach guard's input stamp) and
 * the width-appended render key (`taskKeyOf(...) + "\u0000" + width`).
 *
 * @param prefix - The key's discriminator prefix.
 * @param stamps - The input segments (the caller pre-strings optionals).
 * @returns The joined key.
 */
export function taskKeyOf(prefix: string, stamps: Array<string | number>): string {
  return `${prefix}\u0000${stamps.join("\u0000")}`;
}

/**
 * The streaming key stamp — the result-preview settle splitter: pending
 * frames carry it, the settled frame does not, so the settle identity
 * differs from every partial's and the attach guard re-arms the one-time
 * highlighted render even when the content no longer grows. Lives beside
 * taskKeyOf (the key machinery's home); the streaming VOCABULARY
 * (resultStreaming, argsSettled) stays in tool-services.
 *
 * @param streaming - Whether the frame's content is still growing.
 * @returns The stamp ("s"), or "" for settled frames.
 */
export function streamingStamp(streaming: boolean): string {
  return streaming ? "s" : "";
}

/** The outputTaskKey inputs. */
export interface OutputTaskKeyOptions {
  /** The tool's short prefix ("g"/"f"/"l"). */
  prefix: string;
  /** The derived output identity. */
  derived: DerivedOutput;
  /** The palette/theme identity part. */
  identity: string;
  /** The elapsed milliseconds. */
  elapsedMs: number;
  /** Whether the frame is expanded. */
  expanded: boolean;
  /**
   * The streaming stamp (streamingStamp of the pending state). Highlighted
   * tools pass it so a content-identical final frame re-renders with
   * colors; plain tools omit it — their keys stay as before.
   */
  streaming?: boolean;
}

/**
 * The width-independent swap key grep/find/ls share: content identity
 * (length + fingerprint), palette identity (a theme switch re-renders),
 * footer state (the streaming-partial→final Took delta), the expand mode,
 * and optionally the streaming stamp (the settle re-render for highlighted
 * tools). A resize must NOT re-render these tools (no width-dependent
 * layout), so the callers' key closures ignore the width argument.
 *
 * @param options - The key's inputs.
 * @returns The swap key.
 */
export function outputTaskKey(options: OutputTaskKeyOptions): string {
  const { prefix, derived, identity, elapsedMs, expanded, streaming } = options;
  return taskKeyOf(prefix, [
    derived.output.length,
    derived.hash,
    identity,
    elapsedMs,
    expanded ? "x" : "c",
    ...(streaming === undefined ? [] : [streamingStamp(streaming)]),
  ]);
}

/** The render-state cell a wrapper parks its output memo in. */
export interface OutputMemoCell {
  /** The memo itself (created on first use). */
  memoFor?: WeakMap<object, DerivedOutput>;
}

/** The memoized derivation: result identity in, derived views out. */
export type OutputDerive = (result: object) => DerivedOutput;

/**
 * Bind an output memo to a render-state cell (the wrapper passes its
 * state; the cell survives frames within one tool call).
 *
 * @param cell - The wrapper's render state (the memo's home).
 * @returns The derivation function.
 */
export function outputMemoOf(cell: OutputMemoCell): OutputDerive {
  const weak = (cell.memoFor ??= new WeakMap());
  return (result: object) => {
    const hit = weak.get(result);
    if (hit) return hit;
    const output = inertText(firstTextOf(result));
    const notice = limitNoticeOf(output, (result as ResultDetails).details);
    // The notice's separator blank line (the SDK writes "\n\n[…]") goes
    // with it — neither is content the wrappers window over.
    const body = notice ? output.slice(0, output.lastIndexOf(notice)).trimEnd() : output;
    // ("" keeps the falsy guard: an empty result's line view is [], not
    // [""] — the empty-output path is intercepted by the callers' guards.)
    const lines = body ? linesOf(body) : [];
    const derived: DerivedOutput = {
      output,
      lines,
      // find/ls filter empty lines (the SDK's path list shape); grep
      // keeps them (a blank line is still an output line for its budget).
      entries: lines.filter((l: string) => l.length > 0),
      notice,
      hash: fnv1a(output),
    };
    weak.set(result, derived);
    return derived;
  };
}

/**
 * Render raw output lines in pi's native look (the toolOutput foreground,
 * one line at a time) — the plain/dim fallback grep/find/ls paint before
 * (or instead of) highlighting. Those three output tools are its only
 * clients, so it lives here beside the vocabulary it serves.
 *
 * @param lines - The output lines (empty array renders empty).
 * @param theme - The active pi theme.
 * @returns The styled text.
 */
export function renderPlainOutput(lines: readonly string[], theme: PaletteTheme): string {
  if (!lines.length) return "";
  return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
}

/**
 * A tool result's content block — the structural subset of pi-ai's
 * TextContent/ImageContent union our render paths read (type + text;
 * signatures and image fields are none of the renderer's business).
 */
export interface ResultContentBlock {
  /** The block type ("text", "image", …). */
  type: string;
  /** The text (text blocks only). */
  text?: string;
}

/**
 * The joined text blocks of a tool result's content (the output memo's
 * and the factory's lazy output's source; no image blocks).
 *
 * @param result - The tool result.
 * @returns The joined text, or "".
 */
export function firstTextOf(result: object): string {
  const content = (result as { content?: ResultContentBlock[] }).content;
  return (
    content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n") ?? ""
  );
}

/**
 * The "(ctrl+o for more)" hint under a collapsed tool output: the actual
 * key from the TUI's keybinding table when reachable, the documented
 * default otherwise (pi installs the expand binding app-side — a bare
 * test process sees only the default).
 *
 * @param theme - The pi theme (colors the hint).
 * @returns The styled hint.
 */
export function expandKeyHint(theme: PaletteTheme): string {
  // pi's own keyHint composition, byte-identically (keybinding-hints.js:
  // fg("dim", keyText(id)) + fg("muted", " " + description)) — pinned by
  // upstream-contracts. The render-time theme instance replaces pi's
  // ambient global (ours is the one pi actually passed in; a bare test
  // process has no global at all), and the "ctrl+o" fallback covers the
  // same bare processes (pi installs the binding table app-side).
  const key = keyText("app.tools.expand") || "ctrl+o";
  return theme.fg("dim", key) + theme.fg("muted", " to expand");
}

/**
 * The call's outcome as a theme color: pending rows stay uncolored (no footer
 * at all), settled rows paint their state (success green, failure by kind).
 */
export type StateColor = "muted" | "success" | "error" | "warning";

/**
 * The `Took 1.2s` footer from the measured execution time — bash's native
 * renderer shows one; grep/find/ls had none until this. Formatting is
 * pi's shell-renderer body byte-identically (`(ms / 1000).toFixed(1)` +
 * "s" — bash.js), so settled rows read the same whichever renderer
 * painted them. The color carries the call's STATE: success on the
 * collapsed tail, the failure kind on an error frame.
 *
 * @param ms - The measured duration in milliseconds.
 * @param theme - The pi theme.
 * @param color - The state color. "muted" has no production caller left
 *   — it is the reserved slot for coloring a native Elapsed footer
 *   should one ever be painted (pi's own stay untouched today).
 * @returns The styled footer line, or "" when unmeasured.
 */
export function tookFooter(ms: number | undefined, theme: PaletteTheme, color: StateColor): string {
  if (ms === undefined) return "";
  return theme.fg(color, `Took ${(ms / 1000).toFixed(1)}s`);
}

/**
 * Arm the execution clock — pi's shell-renderer renderCall body, applied to
 * every wrapper's state. Called on every renderCall frame; only the live
 * execution arms it (a resumed row re-runs renderCall with
 * `executionStarted` false, which is exactly how pi keeps a replayed tool
 * row from showing a duration), and the `startedAt === undefined` guard
 * keeps the clock at the FIRST frame.
 *
 * @param state - The wrapper's render state (the timing fields).
 * @param executionStarted - Whether pi marked this call's execution started.
 */
export function armTiming(state: ExecutionTimingState, executionStarted: boolean): void {
  if (executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
}

/**
 * Stop the execution clock and read the duration — pi's shell-renderer
 * renderResult body. The first settled frame (or any error frame) fixes
 * `endedAt`, so repeated renders of the same row keep one value: the
 * frame cache keys include this duration, and a recomputed one would
 * re-arm the preview task on every updateDisplay.
 *
 * @param state - The wrapper's render state (the timing fields).
 * @param isPartial - Whether the result is still streaming.
 * @param isError - Whether the call settled as an error.
 * @returns The measured milliseconds, or undefined while pending (and on a
 *   resumed row, whose clock was never armed).
 */
export function stopTiming(
  state: ExecutionTimingState,
  isPartial: boolean,
  isError: boolean,
): number | undefined {
  if (!isPartial || isError) state.endedAt ??= Date.now();
  if (state.startedAt === undefined || state.endedAt === undefined) return undefined;
  return state.endedAt - state.startedAt;
}

/** The view's inputs: the budgets and the footer sources. */
export interface ViewOptions {
  /** The collapsed-state line budget (COLLAPSED_LINES.x). */
  budget: number;
  /** Whether the row is expanded (ctrl+o). */
  expanded: boolean;
  /**
   * The expanded-state cap (write's MAX_RENDER_LINES): when set, the
   * expanded view still truncates and reports the remainder in the same
   * tail grammar. Unset = the expanded view shows everything.
   */
  expandedCap?: number;
  /** The measured execution time (undefined while pending, and on a resumed row); unset = no footer. */
  tookMs?: number;
  /** The SDK's limit notice (DerivedOutput.notice) — painted as the warning footer line. */
  notice?: string;
  /** The pi theme (muted fg). */
  theme: PaletteTheme;
}

/** The collapsed window: the shown slice, the tail block, and the hidden count. */
export interface CollapsedWindow {
  /** The lines inside the window. */
  shown: string[];
  /** The tail block (expand hint / notice / Took, "" when nothing follows). */
  tail: string;
  /** The lines the window is hiding (> 0 means the tail leads with the hint). */
  hidden: number;
}

/**
 * The collapsed body view: which lines to show and the affordance tail to
 * append — one authority for the collapse predicate, the hidden-count,
 * and the footer-line tail (expand hint, Took, notice — one per line,
 * the native bash layout) shared by every collapsed body (grep/find/ls,
 * write's create preview). Per-tool
 * variance (the budgets, how lines are derived — filtering empties or
 * not) stays at call sites; this owns the shape: one window concept with
 * two regimes (collapsed budget + optional expanded cap) and one tail
 * grammar.
 *
 * @param lines - The full output lines (already derived per tool).
 * @param opts - The view options (budgets and the measured duration).
 * @returns The shown lines and the tail line ("" when nothing is hidden
 * and no time was measured).
 */
export function collapsedView(lines: string[], opts: ViewOptions): CollapsedWindow {
  const { budget, expanded, expandedCap, tookMs, notice, theme } = opts;
  // An absent result source means no footer (write's create preview —
  // the SDK's own write renderer never showed timing either).
  const collapsed = !expanded && lines.length > budget;
  const window = collapsed ? budget : (expandedCap ?? lines.length);
  const hidden = lines.length - Math.min(lines.length, window);
  const shown = lines.slice(0, window);
  // Footers read top-down: the expand hint, the limit notice (the SDK's
  // warning about the whole output — the native renderers show the same
  // information as a `[Truncated: …]` line), and Took closes the tail
  // (the native bash order: warnings before Took). One blank line
  // between, the error frame's rhythm.
  const alert = notice ? theme.fg("warning", notice) : "";
  const tail = [
    // The collapsed regime advertises the expand key; an expanded cap
    // reports the remainder without an affordance.
    collapseTail(hidden, theme, expanded ? "" : expandKeyHint(theme)),
    alert,
    // "success" is an invariant here, not a state check: the factory's
    // renderResult error branch returns before spec.renderResult runs (an
    // error result never reaches this view), and a pending frame's
    // stopTiming returns undefined (no footer at all) — a tail footer
    // exists only on a settled, successful call.
    tookFooter(tookMs, theme, "success"),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { shown, tail, hidden };
}
