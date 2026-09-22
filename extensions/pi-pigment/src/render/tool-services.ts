/**
 * Shared tool-wrapper types: the services the assembly injects into the
 * wrappers, the render context the TUI hands to renderers, and the
 * per-tool render states.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { IndicatorStyle } from "#src/config/config-schema.ts";
import type { ParsedDiff } from "#src/core/diff.ts";

import type { RenderSession } from "./session.ts";
import type { TextComponentFactory } from "./text-task.ts";

/**
 * The SDK's render context for the default generics (the render slot of
 * `ToolDefinition`); `TState` is the wrapper's own render state: the TUI
 * initializes it as `{}` and the wrapper's fields populate lazily, so
 * every state field is optional by contract.
 */
type SdkRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/**
 * The render context the TUI passes to renderCall/renderResult — the
 * SDK's shape, narrowed: `args` stays `unknown` at the boundary and
 * `state` is the wrapper's own `TState`. The compile-time canary below
 * fails when upstream adds a context field, so carrying it is a decision.
 */
export interface RenderContext<TState extends object = Record<string, unknown>> extends Omit<
  SdkRenderContext,
  "args" | "expanded" | "showImages" | "state"
> {
  /** Current tool call arguments (unknown at the boundary). */
  args: unknown;
  /** Shared renderer state for this tool row (the wrapper's own shape). */
  state: TState;
}

// Upstream adding a render-context field stops the build here until the
// projection above decides to carry it (same canary pattern as
// upstream-contracts.test.ts).
// eslint-disable-next-line no-unused-vars -- the type check IS the usage
const CONTEXT_FIELDS_ACCOUNTED_FOR: Exclude<keyof SdkRenderContext, keyof RenderContext> extends
  | "args"
  | "expanded"
  | "showImages"
  | "state"
  ? true
  : false = true;

/**
 * Read a render slot's arguments as a partial tool input — the one cast
 * helper for the `(args ?? {}) as Partial<X>` idiom every wrapper opens
 * with (args is `unknown` at the boundary; the wrapper knows its shape).
 *
 * @param args - The raw render args (ctx.args or renderArgs).
 * @returns The partial input view.
 */
export function argsOf<T extends object>(args: unknown): Partial<T> {
  return (args ?? {}) as Partial<T>;
}

/**
 * Whether the call's arguments can no longer grow. Live, this is
 * argsComplete (the TUI sets it when the streamed args JSON closes);
 * restored sessions never get that mark — but their final result (isPartial
 * false) means the same thing. One concept, two arrival paths.
 *
 * @param ctx - The render context.
 * @returns True when the arguments are settled.
 */
export function argsSettled(ctx: RenderContext<object>): boolean {
  return ctx.argsComplete || !ctx.isPartial;
}

/**
 * The call's three-state outcome every frame consumes — derived from the
 * SDK projection's two booleans (error wins over pending).
 */
export type CallState = "pending" | "success" | "error";

/**
 * Derive the call's outcome state: the single home for the error/pending
 * precedence, so frame painters speak the three-state model instead of
 * combining booleans per site.
 *
 * @param ctx - The render context.
 * @returns The call's outcome state.
 */
export function callStateOf(ctx: RenderContext<object>): CallState {
  return ctx.isError ? "error" : ctx.isPartial ? "pending" : "success";
}

/**
 * Whether the call's result may still grow: the preview frames' streaming
 * gate, derived from the three-state model. Only PENDING calls stream;
 * error frames never reach the result previews (the factory intercepts
 * them), so pending and result growth coincide everywhere previews render.
 *
 * @param ctx - The render context.
 * @returns True while the result's content is still streaming.
 */
export function resultStreaming(ctx: RenderContext<object>): boolean {
  return callStateOf(ctx) === "pending";
}

/**
 * The execution-timing fields every wrapper's render state carries. pi's
 * shell renderer owns the mechanism (renderCall arms `startedAt` while
 * the execution is live, renderResult fixes `endedAt` on the settled
 * frame) and reads them for bash/powershell's own `Took`/`Elapsed`
 * footer; the factory drives the SAME two fields for every wrapper so the
 * grep/find/ls footers and the error frame read one source. Nothing about
 * timing is persisted into the session: a resumed row never armed
 * `startedAt`, so it shows no duration — matching pi's native renderers.
 */
export interface ExecutionTimingState {
  /** Armed by renderCall while the execution is live (pi's contract). */
  startedAt?: number;
  /** Fixed by the first settled renderResult (pi's contract). */
  endedAt?: number;
}

/**
 * The shell failure taxonomy parsed from an error message's status line
 * (the patterns live beside error-frame's UPSTREAM CONTRACT MIRROR).
 * Exit codes 128-255 are the signal range (killed/terminated) — a
 * different failure KIND than a plain non-zero exit (Ghostty's
 * command-blocks stripe makes the same distinction), and it earns its
 * own color.
 */
export interface ShellExitBadge {
  /** The failure kind. */
  kind: "error" | "signal" | "timeout" | "aborted" | "terminated";
  /**
   * The exit code (error/signal) or the timeout seconds (timeout); 0 for
   * the code-less kinds (aborted/terminated).
   */
  value: number;
}

/**
 * The shell tools' render state. Co-authored with the SDK: our renderCall
 * stashes the command fields, and the SDK's native bash/powershell
 * renderResult (which the wrapper delegates output rendering to) reads
 * the timing fields and owns the ticking `interval` for its live display —
 * this type is the contract both sides write into.
 */
export interface ShellState extends ExecutionTimingState {
  /** The command string (stashed by renderCall). */
  command?: string;
  /** The command + theme identity the highlighted form was computed for (staleness). */
  commandHighlightFor?: string;
  /** The shell-grammar highlighted command (swapped in by renderCall). */
  commandHighlight?: string;
  /**
   * The native result renderer's elapsed-time interval — it re-renders
   * every second while a partial result streams, and clears it in its own
   * final render. The factory sweeps it on every FINAL frame (success or
   * error) so no path that replaces that render leaks it.
   */
  interval?: ReturnType<typeof setInterval>;
  /**
   * The parsed failure badge, bridged by onError from the error message's
   * status line — the call header's "✗ exit 1" suffix reads it on the
   * frame after the error lands. Meaningless outside the error state
   * (which is terminal), so renderCall drops it on any non-error frame —
   * a state re-armed for a new execution starts badge-free.
   */
  exitBadge?: ShellExitBadge;
}

/**
 * The create-preview stats (write's new-file path): the content's line
 * count and fingerprint, keyed by the content REFERENCE — settled args
 * are frozen, so the reference is stable frame to frame and the scans
 * run once per call, not per updateDisplay frame.
 */
export interface NewFileStatsMemo {
  /** The content string the stats were computed from. */
  content: string;
  /** The content's line count (0 for empty). */
  lineCount: number;
  /** The content's FNV-1a fingerprint (the identity key's seal). */
  fingerprint: string;
}

/**
 * Write's render state: the existence-probe cache (renderCall), the
 * create-preview stats memo (renderResult), and the stats stash
 * renderResult bridges from result details (the "+N −M" call-header
 * suffix).
 */
export interface WriteState {
  /** The existence probe cache (per path — renderCall probes sync, once). */
  existsProbes?: Record<string, boolean>;
  /** The create-preview stats memo (see {@link NewFileStatsMemo}). */
  newFileStats?: NewFileStatsMemo;
  /**
   * The +added/−removed counts bridged from result details by
   * renderResult (the call header renders on every update, so it
   * picks these up on the next frame).
   */
  added?: number;
  /** The removed count (see added). */
  removed?: number;
  /** The no-change confirmation (bridged once; the header suffix reads it). */
  noChange?: boolean;
}

/**
 * The parse memo: a frozen patch's ParsedDiff keyed by patch identity
 * (renderResult re-runs per frame; the parse must not).
 */
export interface ParsedDiffMemo {
  /** The patch text the diff was parsed from. */
  patch: string | undefined;
  /** The parsed diff (undefined when the patch had no changes). */
  diff: ParsedDiff | undefined;
}

/**
 * The edit wrapper's per-call render state (bridges execute→renderResult
 * facts into the header suffix and caches the diff parse + the seed's
 * file lines).
 */
export interface EditState {
  /** The edit-operation count (bridged with the diff stats). */
  editCount?: number;
  /**
   * The seed source's lines for embedded grammars: the edited file read
   * once per call (undefined = not read yet, null = unreadable). The row
   * has one path, so the memo needs no key; see the seed producer in
   * tool-edit.ts.
   */
  seedLines?: string[] | null;
  /** The parse memo (identity-keyed; see {@link ParsedDiffMemo}). */
  parsedDiff?: ParsedDiffMemo;
  /** The parsed-diff line count. */
  diffLines?: number;
  /** The added-line count. */
  added?: number;
  /** The removed-line count. */
  removed?: number;
}

/** Services the tool wrappers need from the assembly. */
export interface ToolServices {
  /** Path shortener for headers (relative to cwd, `~` for home). */
  shortPath: (p: string) => string;
  /** Configured left-edge change-indicator style. */
  indicatorStyle: IndicatorStyle;
  /** The pi-tui Text class (for fresh components). */
  textFactory: TextComponentFactory;
  /**
   * The per-session render seam (session.ts) — the one read path
   * for the session's derived state (palette, resolved token theme,
   * highlighting). The factory binds it per frame (`forTheme(theme)`);
   * nothing else in the render pipeline reads session state.
   */
  render: RenderSession;
}
