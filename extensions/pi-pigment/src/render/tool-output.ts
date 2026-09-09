/**
 * The result-BODY rendering vocabulary: the output memo (identity-keyed
 * derive), the collapsed-view window authority
 * (CONTEXT.md: one window concept, the budgets + tail grammar), and the
 * elapsed-ms sideband the Took footer reads. The TUI contract (render
 * context, per-tool states) and the assembly inputs stay in
 * tool-services; wrappers import their slice by intent — a wrapper's
 * import list reads as its contract.
 */
import { keyText } from "@earendil-works/pi-coding-agent";
import prettyMilliseconds from "pretty-ms";

import { inertText } from "#src/core/ansi.ts";
import { fnv1a } from "#src/core/fingerprint.ts";
import { linesOf } from "#src/core/lines.ts";
import type { PaletteTheme } from "#src/theme/palette.ts";

/**
 * The collapsed-state line budget per tool — the same numbers the SDK's
 * native renderers use (grep 15, find/ls 20, write 10), so pi-pigment's
 * collapsed previews show exactly as much as the built-ins would.
 */
export const COLLAPSED_LINES = { grep: 15, find: 20, ls: 20, write: 10 } as const;

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
  /** All lines, empty lines kept (grep's budget unit). */
  lines: string[];
  /** Non-empty lines (find/ls: the SDK's path-list shape). */
  entries: string[];
  /** The content fingerprint (the swap key's identity component). */
  hash: string;
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
}

/**
 * The width-independent swap key grep/find/ls share: content identity
 * (length + fingerprint), palette identity (a theme switch re-renders),
 * footer state (the streaming-partial→final Took delta), and the expand
 * mode. A resize must NOT re-render these tools (no width-dependent
 * layout), so the callers' key closures ignore the width argument.
 *
 * @param options - The key's inputs.
 * @returns The swap key.
 */
export function outputTaskKey(options: OutputTaskKeyOptions): string {
  const { prefix, derived, identity, elapsedMs, expanded } = options;
  return taskKeyOf(prefix, [
    derived.output.length,
    derived.hash,
    identity,
    elapsedMs,
    expanded ? "x" : "c",
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
    // ("" keeps the falsy guard: an empty result's line view is [], not
    // [""] — the empty-output path is intercepted by the callers' guards.)
    const lines = output ? linesOf(output) : [];
    const derived: DerivedOutput = {
      output,
      lines,
      // find/ls filter empty lines (the SDK's path list shape); grep
      // keeps them (a blank line is still an output line for its budget).
      entries: lines.filter((l: string) => l.length > 0),
      hash: fnv1a(output),
    };
    weak.set(result, derived);
    return derived;
  };
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
  // keyText resolves the user's binding from pi's keybinding table (the
  // app installs it into pi-tui's global at startup); outside a pi
  // process — a bare test runner — the table is pi-tui's own defaults,
  // which do not carry the app-level id, and the documented default
  // ("ctrl+o", pi's core keybindings) fills in.
  const key = keyText("app.tools.expand") || "ctrl+o";
  return theme.fg("dim", key) + theme.fg("muted", " to expand");
}

/**
 * The `Took 1.2s` footer from the factory-measured execution time —
 * bash's native renderer shows one; grep/find/ls had none until this.
 * Formatting delegates to pretty-ms: same shape in the common range
 * (8ms, 1.2s), minute/hour readability for long runs (1m 5s, 1h 1m 40s),
 * and every rounding boundary is upstream's to keep correct.
 *
 * @param ms - The measured duration in milliseconds.
 * @param theme - The pi theme (muted fg).
 * @returns The styled footer line, or "" when unmeasured.
 */
export function tookFooter(ms: number | undefined, theme: PaletteTheme): string {
  if (ms === undefined) return "";
  return theme.fg("muted", `Took ${prettyMilliseconds(ms)}`);
}

/**
 * The details field the execute timing writes (sideband, pi-pigment-only).
 * A STRING key, not a Symbol — details persists into the session JSONL,
 * and JSON.stringify silently drops symbol-keyed properties (verified:
 * the restored object would lose every footer's Took time).
 */
const ELAPSED_MS_KEY = "pigmentElapsedMs";

/**
 * Stamp the elapsed milliseconds onto a result's details — the sideband
 * WRITER, called by the factory's execute wrapper (this module is the
 * contract's one home: key, writer, and reader together).
 *
 * @param result - The tool result (mutated additively).
 * @param elapsedMs - The measured execution time.
 */
export function stampElapsed(result: { details?: unknown }, elapsedMs: number): void {
  // The SDK tools leave details undefined when empty — create it: the
  // sideband is the one field every wrapper's footer can rely on.
  ((result.details ??= {}) as Record<string, unknown>)[ELAPSED_MS_KEY] = elapsedMs;
}

/**
 * Read the factory-measured execution time from a result's details — the
 * typed reader for the sideband {@link ELAPSED_MS_KEY} writes.
 *
 * @param result - The tool result.
 * @returns The elapsed milliseconds, or undefined when unmeasured.
 */
export function elapsedOf(result: { details?: unknown } | undefined): number | undefined {
  const value = result?.details as Record<string, unknown> | undefined;
  const ms = value?.[ELAPSED_MS_KEY];
  return typeof ms === "number" && Number.isFinite(ms) ? ms : undefined;
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
  /** The tool result (the Took footer's time source); unset = no footer. */
  result?: { details?: unknown };
  /** The pi theme (muted fg). */
  theme: PaletteTheme;
}

/**
 * The collapsed body view: which lines to show and the affordance tail to
 * append — one authority for the collapse predicate, the hidden-count,
 * and the `… more lines · ctrl+o · Took` composition shared by every
 * collapsed body (grep/find/ls, write's create preview). Per-tool
 * variance (the budgets, how lines are derived — filtering empties or
 * not) stays at call sites; this owns the shape: one window concept with
 * two regimes (collapsed budget + optional expanded cap) and one tail
 * grammar.
 *
 * @param lines - The full output lines (already derived per tool).
 * @param opts - The view options (budgets and footer sources).
 * @returns The shown lines and the tail line ("" when nothing is hidden
 * and no time was measured).
 */
export function collapsedView(
  lines: string[],
  opts: ViewOptions,
): { shown: string[]; tail: string } {
  const { budget, expanded, expandedCap, result, theme } = opts;
  // An absent result source means no footer (write's create preview —
  // the SDK's own write renderer never showed timing either).
  const collapsed = !expanded && lines.length > budget;
  const window = collapsed ? budget : (expandedCap ?? lines.length);
  const hidden = lines.length - Math.min(lines.length, window);
  const shown = lines.slice(0, window);
  const tail = [
    // The collapsed regime advertises the expand key; an expanded cap
    // reports the remainder without an affordance.
    collapseTail(hidden, theme, expanded ? "" : expandKeyHint(theme)),
    result ? tookFooter(elapsedOf(result), theme) : "",
  ]
    .filter(Boolean)
    .join(theme.fg("muted", " · "));
  return { shown, tail };
}
