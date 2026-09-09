/**
 * Shared test fixtures: fake pi themes, Text-like components, and the mock
 * ExtensionAPI factory used across the render/tool/palette suites. One
 * definition per fixture shape so projections can't drift between suites.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

import pigmentExtension from "#src/index.ts";
import type { PreviewTask } from "#src/render/text-task.ts";
import type { RenderContext } from "#src/render/tool-services.ts";
import { clearHighlightCacheForTest } from "#src/theme/highlight.ts";
import { resetPaletteForTest, setDiffRoots, type PaletteTheme } from "#src/theme/palette.ts";
import { resetSyntaxThemeForTest } from "#src/theme/theme-selection.ts";

/**
 * Fetch one registered tool by name — the suite's standard guard form.
 *
 * @param tools - The registered tool list.
 * @param name - The tool to find.
 * @returns The tool (throws when absent).
 */
export function toolOf<T extends { name: string }>(tools: T[], name: string): T {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} tool not registered`);
  return found;
}

/**
 * Strip ANSI SGR escapes so content assertions see plain text.
 *
 * @param s - The rendered (possibly styled) text.
 * @returns The escape-free text.
 */
// eslint-disable-next-line no-control-regex -- intentionally matches ESC
export const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Poll until the predicate holds — the suite's standard wait for async
 * swap-ins (a fixed sleep is load-fragile; this is bounded and eager).
 *
 * @param predicate - Resolves truthy when the wait is over.
 * @param options - Timing overrides.
 * @param options.timeoutMs - Give up after this long (default 2s).
 * @param options.stepMs - Poll interval (default 20ms).
 * @returns The predicate's truthy value.
 */
export async function waitFor<T>(
  predicate: () => T | undefined,
  options: { timeoutMs?: number; stepMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 2000, stepMs = 20 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: condition never held");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * The suite's one aggregate reset: theme-selection memos, the palette
 * snapshot, the session roots, and the highlight cache — the full set of
 * module-level mutable state a render depends on (short of the shiki
 * core singleton, which is process-scoped by design).
 */
export function resetPigmentForTest(): void {
  resetSyntaxThemeForTest();
  resetPaletteForTest();
  setDiffRoots(undefined);
  clearHighlightCacheForTest();
}

/** Fake theme overrides for buildFakeTheme. */
export interface FakeThemeOverrides {
  diffAdded?: string;
  diffRemoved?: string;
  successBg?: string;
  errorBg?: string;
  /** When true, populate the nine `syntax*` colors (VS Code-style values). */
  syntaxColors?: boolean;
  /** The theme's name (ours-detection reads it). */
  name?: string;
}

/**
 * Build a fake pi theme with a truecolor getFgAnsi/getBgAnsi surface.
 *
 * @param overrides - Per-color overrides for the theme.
 * @returns A PaletteTheme-satisfying fake.
 */
export function buildFakeTheme(overrides?: FakeThemeOverrides): PaletteTheme {
  const fg: Record<string, string> = {
    toolTitle: "\x1b[38;2;138;180;255m",
    accent: "\x1b[38;2;138;180;255m",
    muted: "\x1b[38;2;130;130;140m",
    dim: "\x1b[38;2;110;110;120m",
    success: "\x1b[38;2;100;200;120m",
    error: "\x1b[38;2;255;100;100m",
    toolDiffAdded: overrides?.diffAdded ?? "\x1b[38;2;80;220;120m",
    toolDiffRemoved: overrides?.diffRemoved ?? "\x1b[38;2;240;90;90m",
    toolDiffContext: "\x1b[38;2;130;130;130m",
    ...(overrides?.syntaxColors
      ? {
          syntaxComment: "\x1b[38;2;106;153;85m",
          syntaxKeyword: "\x1b[38;2;86;156;214m",
          syntaxFunction: "\x1b[38;2;220;220;170m",
          syntaxVariable: "\x1b[38;2;156;220;254m",
          syntaxString: "\x1b[38;2;206;145;120m",
          syntaxNumber: "\x1b[38;2;181;206;168m",
          syntaxType: "\x1b[38;2;78;201;176m",
          syntaxOperator: "\x1b[38;2;212;212;212m",
          syntaxPunctuation: "\x1b[38;2;212;212;212m",
        }
      : {}),
  };
  const bg: Record<string, string> = {
    toolSuccessBg: overrides?.successBg ?? "\x1b[48;2;30;30;40m",
    toolErrorBg: overrides?.errorBg ?? "\x1b[48;2;40;30;30m",
  };
  return {
    name: overrides?.name,
    fg: (name: string, text: string) => `${fg[name] ?? ""}${text}\x1b[0m`,
    bg: (name: string, text: string) => `${bg[name] ?? ""}${text}\x1b[0m`,
    getFgAnsi: (name: string) => fg[name] ?? "",
    getBgAnsi: (name: string) => bg[name] ?? "",
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
}

/**
 * A Text-like component with settable text and a no-op render.
 *
 * @returns The component double.
 */
export function makeTextComponent() {
  const state = { text: "" as string };
  return {
    text: state,
    setText(s: string) {
      state.text = s;
    },
    render: (_width: number): string[] => [state.text],
    invalidate: () => {},
    previewTask: undefined as PreviewTask | undefined,
    customBgFn: undefined as ((line: string) => string) | undefined,
    setCustomBgFn(fn?: (line: string) => string) {
      // Mirrors pi-tui's setter: assigns the (private-by-convention) field.
      (this as { customBgFn?: (line: string) => string }).customBgFn = fn;
    },
  };
}

/**
 * The mock Text component's shape — the test seam every inline
 * `as { text: { text: string } }` / `as { previewTask?: … }` cast
 * replicates. Typed from the factory's return (same-source, zero drift).
 */
export type TextDouble = ReturnType<typeof makeTextComponent>;

/**
 * A render context for renderCall/renderResult drivers. Generic over the
 * tool's own render state — tests type it per-tool (the same contract the
 * wrappers compile against).
 *
 * @returns The component and the context, plus an invalidation counter.
 */
export function makeRenderCtx<TState extends object = Record<string, unknown>>() {
  const lastComponent = makeTextComponent();
  const invalidated = { count: 0 };
  // Typed against RenderContext — drift from the interface (stray option
  // fields, missing context fields) becomes a compile error, not a silent
  // fixture lie.
  const ctx: RenderContext<TState> = {
    lastComponent,
    args: undefined,
    toolCallId: "test-call",
    state: {} as TState,
    invalidate: () => {
      invalidated.count++;
    },
    isError: false,
    argsComplete: true,
    isPartial: false,
    executionStarted: false,
    cwd: "/project",
  };
  return { lastComponent, invalidated, ctx };
}

/**
 * A preview-task component driven by tests: the swap protocol's render
 * entry plus the text slot (grep/find/ls results).
 */
export interface DrivenTaskComponent {
  render: (width: number) => string[];
  text: { text: string };
}

/**
 * A component carrying an attached preview task (write/edit results) —
 * drive the task's async render directly.
 */
export interface TaskCarrier {
  previewTask?: { render: (width: number) => Promise<string> };
}

/** A plain text-bearing component (call headers, sync renders). */
export interface TextComponent {
  text: { text: string };
}

/**
 * A registered tool captured by a mock ExtensionAPI, typed as the SDK's
 * ToolDefinition except where the fixture seam deliberately relaxes:
 *
 * - `execute`'s tail parameters accept `unknown` + an optional ctx — the suites invoke execute
 *   without an ExtensionContext (the wrappers never read it; it flows to the SDK origin verbatim),
 *   so a full SDK ctx would force every call site to fabricate one.
 * - `renderCall`/`renderResult` return `unknown` — the fixture's fake Text is not a pi-tui Component
 *   (the makeTextComponent seam below). Everything else — name, label, renderShell, parameters,
 *   prepareArguments, the schema members — carries the SDK's exact type: a ToolDefinition or
 *   WrapperSpec drift (the renderShell field addition that once slipped past the old any-typed
 *   surface) now fails at compile time instead of at the first test assertion.
 */
export type RegisteredTool = Omit<
  ToolDefinition,
  "execute" | "renderCall" | "renderResult" | "constrainedSampling" | "executionMode"
> & {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx?: unknown,
  ) => Promise<AgentToolResult<unknown>>;
  renderCall?: (args: unknown, theme: unknown, ctx: unknown) => unknown;
  renderResult?: (result: unknown, options: unknown, theme: unknown, ctx: unknown) => unknown;
};

/**
 * Drive the extension's session_start like pi does and collect the tools
 * it registers. Without `env`, the session reads the REAL machine's config
 * layers (agent dir defaults to ~/.pi/agent) — files needing isolation pass
 * an empty temp dir for both roots.
 *
 * @param env - Explicit session roots; defaults to the process's own.
 * @returns The registered tools.
 */
export async function registerTools(
  env: { cwd?: string; agentDir?: string } = {},
): Promise<RegisteredTool[]> {
  // DEFAULT ISOLATION: without env, both layers point at paths that hold
  // nothing (the extension's agentDir comes from PI_CODING_AGENT_DIR,
  // set before its session_start runs; a missing layer is skipped by
  // design — no file, no issue). Tests that WANT real layers pass env
  // explicitly. No temp dir: some suites run under memfs, where a real
  // mkdtemp would ENOENT.
  // Suites that stage their own isolation (PI_CODING_AGENT_DIR already
  // set, or env passed) keep it — the default only fills the gap.
  const isolated =
    env.cwd === undefined &&
    env.agentDir === undefined &&
    process.env.PI_CODING_AGENT_DIR === undefined;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (isolated) process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-pigment-test/agent";
  try {
    return await driveSession(env, isolated ? "/nonexistent-pi-pigment-test/project" : undefined);
  } finally {
    if (isolated) {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  }
}

/**
 * Fire the extension's session_start like pi does and collect the tools.
 *
 * @param env - Explicit session roots (either may be undefined).
 * @param defaultCwd - The cwd to use when env.cwd is absent.
 * @returns The registered tools.
 */
async function driveSession(
  env: { cwd?: string; agentDir?: string },
  defaultCwd: string | undefined,
): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];
  // The extension registers tools on session_start — fire it like pi
  // does (and await it: the handler is async — pi's runner awaits every
  // handler's promise, and the tools only exist once it settles).
  let sessionStart: ((event: unknown, ctx: { cwd: string }) => void | Promise<void>) | undefined;
  await pigmentExtension({
    on: (
      event: string,
      handler: (event: unknown, ctx: { cwd: string }) => void | Promise<void>,
    ) => {
      if (event === "session_start") sessionStart = handler;
    },
    // Map-by-name like the SDK's own loader (a re-registration replaces,
    // it does not accumulate) — a push here would fake 14 tools under a
    // double session_start.
    registerTool: (tool: RegisteredTool) => {
      const i = tools.findIndex((existing) => existing.name === tool.name);
      if (i >= 0) tools[i] = tool;
      else tools.push(tool);
    },
    // The presence surfaces the fff probe reads (commands register at
    // module load, before any session_start — the order-safe signal).
    getAllTools: () => tools.map((tool) => ({ name: tool.name })),
    getCommands: () => [],
    // The /pigment command registers at module load (recorded, not run).
    registerCommand: (_name: string, _options: unknown) => {},
  } as never);
  await sessionStart?.(
    { type: "session_start", reason: "startup" },
    { cwd: env.cwd ?? defaultCwd ?? process.cwd() },
  );
  return tools;
}

/**
 * The render-driver theme: pass-through fg/bold (no ANSI wrapping) with the
 * exact diff/toolBg getters the original render suite snapshots were captured
 * under — keeps the behavior snapshots byte-stable.
 *
 * @returns The snapshot-stable fake theme.
 */
export function buildRenderTheme(): PaletteTheme {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    getFgAnsi: (name: string) =>
      name === "toolDiffAdded"
        ? "\x1b[38;2;100;180;120m"
        : name === "toolDiffRemoved"
          ? "\x1b[38;2;200;100;100m"
          : "\x1b[38;2;128;128;128m",
    getBgAnsi: (name: string) =>
      name === "toolSuccessBg" ? "\x1b[48;2;30;30;40m" : "\x1b[48;2;40;30;30m",
    bg: (name: string, text: string) =>
      (name === "toolSuccessBg" ? "\x1b[48;2;30;30;40m" : "\x1b[48;2;40;30;30m") +
      text +
      "\x1b[49m",
  };
}
