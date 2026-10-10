/**
 * Shared test fixtures: fake pi themes, Text-like components, and the mock
 * ExtensionAPI factory used across the render/tool/scheme suites. One
 * definition per fixture shape so projections can't drift between suites.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
  ToolRendererResolver,
  ToolRenderResultOptions,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createPigmentExtension } from "#src/extension.ts";
import {
  createFrameSession,
  type FrameSession,
  type FrameView,
  type RenderSessionInputs,
} from "#src/render/session.ts";
import type { PreviewTask, PreviewTextHost } from "#src/render/text-task.ts";
import type { RenderContext, ToolServices } from "#src/render/tool-services.ts";
import { clearHighlightCacheForTest } from "#src/theme/highlight.ts";
import type { RenderTheme } from "#src/theme/scheme.ts";
import type { ThemeSelection } from "#src/theme/theme-resolver.ts";

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
 * The suite's one aggregate reset: the highlight cache (the only
 * module-level state left in the render path — keyed on content, so most
 * suites don't need it, but theme-swap suites do).
 */
export function resetPigmentForTest(): void {
  clearHighlightCacheForTest();
}

/** The default session inputs for tests: auto selection, no roots, no env. */
const DEFAULT_TEST_ENV = {
  cwd: "/nonexistent-pi-pigment-test/project",
  agentDir: "/nonexistent-pi-pigment-test/agent",
};

/**
 * Build a RenderSession from explicit inputs, with auto/no-root defaults —
 * the tests' session-seam entry.
 *
 * @param inputs - Partial overrides (undefined fields take the defaults).
 * @returns A session the renderer suites can drive renders through.
 */
export function makeRenderSession(inputs: Partial<RenderSessionInputs> = {}): FrameSession {
  return createFrameSession({
    diffRoots: undefined,
    selection: { kind: "auto" } satisfies ThemeSelection,
    themeEnv: DEFAULT_TEST_ENV,
    convertedThemes: [],
    ...inputs,
  });
}

/**
 * A FrameView bound to a fake theme — the theme/render suites' entry to
 * the session seam.
 *
 * @param theme - The pi theme (defaults to the fake).
 * @param inputs - Optional session input overrides (selection, roots, ...).
 * @returns The frame view.
 */
export function viewFor(
  theme: RenderTheme = buildFakeTheme(),
  inputs: Partial<RenderSessionInputs> = {},
): FrameView {
  return makeRenderSession(inputs).forTheme(theme);
}

/**
 * The renderer assembly services with test defaults (identity shortPath,
 * bar indicators, ellipsis off, the real Text class, a fresh session).
 * Typed against ToolServices — a missing field is a compile error,
 * not a silent `as never` lie.
 *
 * @param overrides - Per-field overrides.
 * @returns The assembly services.
 */
export function makeServices(overrides: Partial<ToolServices> = {}): ToolServices {
  return {
    cwd: "/test",
    shortPath: (p: string) => p,
    indicatorStyle: "bar",
    headerEllipsis: "off",
    textFactory: Text,
    render: makeRenderSession(),
    ...overrides,
  };
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
 * @returns A RenderTheme-satisfying fake.
 */
export function buildFakeTheme(overrides?: FakeThemeOverrides): RenderTheme {
  const fg: Record<string, string> = {
    toolTitle: "\x1b[38;2;138;180;255m",
    accent: "\x1b[38;2;138;180;255m",
    muted: "\x1b[38;2;130;130;140m",
    dim: "\x1b[38;2;110;110;120m",
    success: "\x1b[38;2;100;200;120m",
    warning: "\x1b[38;2;230;170;80m",
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
    searchMatchBg: "\x1b[48;2;80;60;20m",
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
export function makeTextComponent(): TextDouble {
  const state = { text: "" as string };
  return {
    text: state,
    setText(s: string) {
      state.text = s;
    },
    render: (_width: number): string[] => [state.text],
    invalidate: () => {},
    previewTask: undefined as PreviewTask | undefined,
    previewRenderedKey: undefined as string | undefined,
    previewIdentity: undefined as string | undefined,
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
 * replicates. Named (not inferred): the factory annotates it, the
 * aliases Pick from it — one source, zero drift. Extends
 * PreviewTextHost (every member is present), so doubles pass to
 * host-typed seams without a cast.
 */
export interface TextDouble extends PreviewTextHost {
  /** The mutable text slot (shared reference — setText writes through). */
  text: { text: string };
  /** Replace the text slot's content. */
  setText: (s: string) => void;
  /** Synchronous frame (the task path upgrades it async). */
  render: (width: number) => string[];
  /** Asks the TUI to redraw (no-op in the harness). */
  invalidate: () => void;
  /** The attached preview task, if any. */
  previewTask: PreviewTask | undefined;
  /** The in-flight task's key (the stale-guard suites supersede it). */
  previewRenderedKey: string | undefined;
  /** The attach guard's identity stamp. */
  previewIdentity: string | undefined;
  /** The row background painter. */
  customBgFn: ((line: string) => string) | undefined;
  /** Assign the row background painter. */
  setCustomBgFn: (fn?: (line: string) => string) => void;
}

/**
 * Render-context fields pi 1.1 added: `durationMs` (the recorded execution
 * time) and `outputPad` (the configured horizontal padding). Spread into
 * fixture contexts rather than written inline — pi 1.0.1's tool render context
 * has neither field, and an inline literal would trip the excess-property
 * check there, so spreading keeps the fixtures compiling across the peer
 * range.
 */
export const RENDER_CONTEXT_ADDITIONS = { durationMs: undefined, outputPad: 0 };

/**
 * A render context for renderCall/renderResult drivers. Generic over the
 * tool's own render state — tests type it per-tool (the same contract the
 * renderers compile against).
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
    expanded: false,
    invalidate: () => {
      invalidated.count++;
    },
    isError: false,
    argsComplete: true,
    isPartial: false,
    executionStarted: false,
    cwd: "/project",
    ...RENDER_CONTEXT_ADDITIONS,
  };
  return { lastComponent, invalidated, ctx };
}

/**
 * The renderCall suites' one-step prologue: register the tools, pull one
 * by name, and guard its renderCall — the four-line header every call test
 * used to repeat, collected here so the non-null guard can't be forgotten
 * in a new suite. Like toolOf, the guard throws when the tool (or its
 * renderCall) is missing.
 *
 * @param name - The tool to pull (e.g. "bash").
 * @returns The guarded renderCall plus makeRenderCtx's bundle (ctx,
 *   invalidated, lastComponent), the ctx typed to the tool's state.
 */
export async function renderCallFor<TState extends object = Record<string, unknown>>(name: string) {
  const tools = await registerTools();
  const tool = toolOf(tools, name);
  if (!tool.renderCall) throw new Error(`${name} renderCall not registered`);
  return { renderCall: tool.renderCall, ...makeRenderCtx<TState>() };
}

/**
 * Seed a settled execution span into a render ctx — the Took footers read
 * their duration from here (pi's render-state clock, armed by renderCall
 * while the execution is live and stopped by the first settled frame), not
 * from the result. Suites asserting a `Took` line seed the span; suites
 * asserting its ABSENCE leave the clock unarmed (which is also what a row
 * replayed from a session looks like).
 *
 * @param ctx - The render context whose state carries the clock.
 * @param ms - The span to seed, in milliseconds.
 */
export function seedTiming(ctx: RenderContext<object>, ms = 12): void {
  const state = ctx.state as Record<string, unknown>;
  // Fixed base, not Date.now(): only the SPAN is ever read, and a clock
  // read here would make an exact-duration assertion flake at a ms boundary.
  state.startedAt = 1_000_000;
  state.endedAt = 1_000_000 + ms;
}

/**
 * A preview-task component driven by tests: the swap protocol's render
 * entry plus the text slot (grep/find/ls results). A TextDouble slice —
 * hand-written copies drift; Pick-on-TextDouble cannot. `previewRenderedKey`
 * rides along: the stale-guard suites supersede it mid-flight.
 */
export type DrivenTaskComponent = Pick<
  TextDouble,
  "render" | "text" | "previewIdentity" | "previewRenderedKey"
>;

/**
 * A component carrying an attached preview task (write/edit results) —
 * drive the task's async render directly. A TextDouble slice —
 * hand-written copies drift; Pick-on-TextDouble cannot.
 */
export type TaskCarrier = Pick<TextDouble, "previewTask">;

/**
 * A shell renderer narrowed to its renderCall entry (createShellRenderer's
 * SDK-typed surface takes unknown-typed args/theme/ctx in tests).
 */
export interface RenderCallCarrier {
  /** Invoke the renderer's renderCall with test-shaped inputs. */
  renderCall: (args: unknown, theme: unknown, ctx: unknown) => TextComponent & TaskCarrier;
}

/**
 * A tool narrowed to its renderResult entry (create*Renderer's SDK-typed
 * surface takes unknown-typed result/options/theme/ctx in tests).
 */
export interface RenderResultCarrier {
  /** Invoke the renderer's renderResult with test-shaped inputs. */
  renderResult: (
    result: unknown,
    options: unknown,
    theme: unknown,
    ctx: unknown,
  ) => DrivenTaskComponent & TaskCarrier;
}

/** A plain text-bearing component (call headers, sync renders). */
export type TextComponent = Pick<TextDouble, "text">;

/**
 * A registered tool captured by a mock ExtensionAPI, typed as the SDK's
 * ToolDefinition except where the fixture seam deliberately relaxes:
 *
 * - `execute`'s tail parameters accept `unknown` + an optional ctx — the suites invoke execute
 *   without an ExtensionContext (the renderers never read it; it flows to the SDK origin verbatim),
 *   so a full SDK ctx would force every call site to fabricate one.
 * - `renderCall`/`renderResult` accept `result`/`args` as `unknown` (heterogeneous per-tool payloads)
 *   but their THEME is the RenderTheme the renderers actually render against, their OPTIONS the
 *   SDK's own ToolRenderResultOptions (the literal shape every call site passes), their ctx the
 *   fixture's RenderContext, and their return the TextDouble the mock produces. Everything else —
 *   name, label, renderShell, parameters, prepareArguments, the schema members — carries the SDK's
 *   exact type: a ToolDefinition or RendererSpec drift (the renderShell field addition that once
 *   slipped past the old any-typed surface) now fails at compile time instead of at the first test
 *   assertion.
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
  renderCall?: (args: unknown, theme: RenderTheme, ctx: RenderContext<object>) => TextDouble;
  renderResult?: (
    result: unknown,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    ctx: RenderContext<object>,
  ) => TextDouble;
};

/**
 * Drive the extension's session_start like pi does and collect the tools
 * it registers. Without `env`, the session reads the REAL machine's config
 * layers (agent dir defaults to ~/.pi/agent) — files needing isolation pass
 * an empty temp dir for both roots.
 *
 * @param env - Explicit session roots; defaults to the process's own.
 * @param foreignTools - Tool names another extension already owns.
 * @param sharedRegistry - Optional cross-fire registry (see driveSession).
 * @param foreignCommands - Command names other extensions already registered.
 * @returns The registered tools.
 */
export async function registerTools(
  env: { cwd?: string; agentDir?: string; projectTrusted?: boolean } = {},
  foreignTools: string[] = [],
  sharedRegistry?: RegisteredTool[],
  foreignCommands: string[] = [],
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
    return await driveSession(
      env,
      isolated ? "/nonexistent-pi-pigment-test/project" : undefined,
      foreignTools,
      sharedRegistry,
      foreignCommands,
    );
  } finally {
    if (isolated) {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  }
}

/**
 * The API surface driveSession's mock actually implements — declared with
 * precise member shapes so a name or signature drift fails at compile
 * time. The crossing into the SDK's full ExtensionAPI (a big overloaded
 * interface the mock never drives) narrows to one boundary cast.
 */
interface MockPiApi {
  on: (event: string, handler: MockEventHandler) => void;
  // RegisteredTool is the extension's own registration shape (see above).
  registerTool: (tool: RegisteredTool) => void;
  // The resolver registration the extension makes once at load — captured
  // so driveSession can drive it per tool name (the SDK runs resolvers in
  // load order at render time; the harness calls the one resolver directly).
  registerToolRenderer: (resolver: ToolRendererResolver) => void;
  // Mirrors pi's merged registry entry shape the yield check reads
  // (name + sourceInfo.source): foreign tools staged by a suite carry
  // their owner's source, the eight builtins source "builtin".
  getAllTools: () => Array<{ name: string; sourceInfo: { source: string } }>;
  getCommands: () => Array<{ name: string }>;
  registerCommand: (name: string, options: unknown) => void;
}

/** A captured non-session-start event handler (tool_call/tool_result). */
type MockEventHandler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

/**
 * The session-start context slice the extension reads. `isProjectTrusted`
 * mirrors pi's ExtensionContext; the rest of pi's context surface is
 * neither mocked nor driven here.
 */
interface MockSessionContext {
  cwd: string;
  isProjectTrusted: () => boolean;
}

/**
 * The built-in tool-definition factories the facade rebuilds, keyed by
 * name. pi's renderer resolver hands pigment only the built-in RENDERERS
 * via `next()`, but the test suites still drive execution — so the facade
 * rebuilds the SDK's own definition (execute + metadata) and overlays the
 * resolved renderers, exactly the shape a registered tool has in prod.
 */
const BUILTIN_DEFINITIONS: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
  write: createWriteToolDefinition,
  edit: createEditToolDefinition,
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
  grep: createGrepToolDefinition,
  ls: createLsToolDefinition,
  find: createFindToolDefinition,
  read: createReadToolDefinition,
};

/**
 * Pick the renderer triple off an SDK tool definition — the test-side
 * adapter that turns a full `ToolDefinition` into the `ToolRenderers` seam
 * the resolver speaks.
 *
 * @param definition - The tool definition to read the renderers from.
 * @returns The `{renderShell, renderCall, renderResult}` triple.
 */
function renderersOf(definition: ToolDefinition): ToolRenderers {
  return {
    renderShell: definition.renderShell,
    renderCall: definition.renderCall,
    renderResult: definition.renderResult,
  };
}

/** The eight decoratable names, in the order the resolver is driven. */
const TOOL_ORDER = ["write", "edit", "bash", "powershell", "grep", "ls", "find", "read"] as const;

/**
 * Fire the extension's session_start like pi does, then collect the tools
 * the resolver decorates. Without `env`, the session reads the REAL
 * machine's config layers (agent dir defaults to ~/.pi/agent) — files
 * needing isolation pass an empty temp dir for both roots.
 *
 * @param env - Explicit session roots; defaults to the process's own.
 * @param defaultCwd - The session cwd the resolver pairs with the renderers.
 * @param foreignTools - Tool names another extension already owns.
 * @param _sharedRegistry - Retained for call-site compatibility; the
 *   resolver architecture registers no tool, so this is unused.
 * @param foreignCommands - Command names other extensions already registered.
 * @returns The decoratable tools with the resolved renderers.
 */
async function driveSession(
  env: { cwd?: string; agentDir?: string; projectTrusted?: boolean },
  defaultCwd: string | undefined,
  foreignTools: string[] = [],
  _sharedRegistry?: RegisteredTool[],
  foreignCommands: string[] = [],
): Promise<RegisteredTool[]> {
  // A prior fire's registrations never exist now (the extension registers
  // no tools), so the mock's registry holds only foreign names + builtins.
  let sessionStart: ((event: unknown, ctx: MockSessionContext) => void | Promise<void>) | undefined;
  // Non-session-start handlers (the write-details channel's tool_call/
  // tool_result pair) — captured so the execute renderer below can fire
  // them the way pi's runner does.
  const handlers = new Map<string, MockEventHandler[]>();
  // The resolver the extension registers at load.
  let toolRendererResolver: ToolRendererResolver | undefined;
  const api: MockPiApi = {
    on: (event: string, handler: MockEventHandler) => {
      if (event === "session_start") {
        sessionStart = handler as (event: unknown, ctx: MockSessionContext) => void | Promise<void>;
        return;
      }
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: () => {},
    registerToolRenderer: (resolver: ToolRendererResolver) => {
      toolRendererResolver = resolver;
    },
    // The presence surfaces the fff probe reads (commands register at
    // module load, before any session_start — the order-safe signal).
    // sourceInfo mirrors real pi: foreign tools under the neighbor's
    // path, the eight builtins with source builtin — a builtin name alone
    // never triggers a skip (the reverse assertion pins this).
    getAllTools: () => [
      ...foreignTools.map((name) => ({
        name,
        // Real pi stamps extension TOOLS with source "local"/"temporary"
        // (loader createExtension); "extension" is the COMMANDS mapping
        // (agent-session getCommands). claimedByOther only reads
        // !== "builtin", so either value exercises it — "local" is the
        // faithful one.
        sourceInfo: { source: "local", path: "/foreign-extension" },
      })),
      ...TOOL_ORDER.map((name) => ({
        name,
        sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
      })),
    ],
    // The /pigment command registers at factory time (before any
    // session_start).
    getCommands: () => [
      { name: "pigment", sourceInfo: { source: "extension", path: "/pi-pigment" } },
      ...foreignCommands.map((name) => ({ name })),
    ],
    registerCommand: (_name: string, _options: unknown) => {},
  };
  await createPigmentExtension(api as unknown as ExtensionAPI);
  const ctx: MockSessionContext = {
    cwd: env.cwd ?? defaultCwd ?? process.cwd(),
    // pi resolves trust before its first session_start; default to the
    // trusted branch (pigment's pre-trust behavior) unless a suite
    // stages the untrusted one.
    isProjectTrusted: () => env.projectTrusted ?? true,
  };
  await sessionStart?.({ type: "session_start", reason: "startup" }, ctx);

  // Rebuild each decoratable tool the resolver claims: the SDK definition
  // (execute + metadata) overlaid with the resolver's renderer triple. A
  // yield (`next()` returned, i.e. the built-in triple handed back by
  // reference) or a missing resolver drops the name — the same "not
  // decorated" outcome the old registration path produced.
  const resolved: RegisteredTool[] = [];
  if (toolRendererResolver !== undefined) {
    for (const name of TOOL_ORDER) {
      const definition = BUILTIN_DEFINITIONS[name](ctx.cwd);
      const builtIn = renderersOf(definition);
      const renderers = toolRendererResolver(name, () => builtIn);
      if (renderers === undefined || renderers === builtIn) continue;
      resolved.push({ ...definition, ...renderers } as RegisteredTool);
    }
  }
  // Round-trip each tool's execute through the captured tool_call/
  // tool_result handlers — the execution-side seam pi's runner owns in
  // production (the write-details channel depends on it).
  return resolved.map((tool) => wrapExecuteWithHooks(tool, handlers, ctx));
}

/**
 * Wrap a registered tool's execute with the captured tool_call/tool_result
 * round trip: fire the pre-hooks, run the tool, fire the post-hooks, and
 * merge any returned `details` into the result — exactly the runner's
 * merge order (runner.js emitToolResult).
 *
 * @param tool - The registered tool.
 * @param handlers - The captured event handlers by event name.
 * @param ctx - The session context handed to handlers.
 * @returns The tool with the wrapped execute.
 */
function wrapExecuteWithHooks(
  tool: RegisteredTool,
  handlers: Map<string, MockEventHandler[]>,
  ctx: MockSessionContext,
): RegisteredTool {
  const callHandlers = handlers.get("tool_call") ?? [];
  const resultHandlers = handlers.get("tool_result") ?? [];
  if (callHandlers.length === 0 && resultHandlers.length === 0) return tool;
  const inner = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, execCtx) => {
      for (const handler of callHandlers) {
        handler({ type: "tool_call", toolName: tool.name, toolCallId, input: params }, ctx);
      }
      const result = await inner(toolCallId, params, signal, onUpdate, execCtx);
      let details = result.details;
      for (const handler of resultHandlers) {
        const hookResult = handler(
          {
            type: "tool_result",
            toolName: tool.name,
            toolCallId,
            input: params,
            content: result.content,
            details,
            isError: result.isError ?? false,
          },
          ctx,
        ) as { details?: unknown } | undefined;
        if (hookResult?.details !== undefined) details = hookResult.details;
      }
      return details === result.details ? result : { ...result, details };
    },
  };
}

/**
 * The render-driver theme: pass-through fg/bold (no ANSI wrapping) with the
 * exact diff/toolBg getters the original render suite snapshots were captured
 * under — keeps the behavior snapshots byte-stable.
 *
 * @returns The snapshot-stable fake theme.
 */
export function buildRenderTheme(): RenderTheme {
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
