/**
 * The extension assembly — the whole runtime wiring (the modules live
 * under src/{core,theme,config,render}).
 *
 * Rendering pipeline (like OpenTUI / delta): Shiki turns code into
 * fg-only ANSI → diff background colors layer underneath (composited at
 * cell level) → word-level changes get a brighter background at the
 * changed char positions. Syntax fg + diff bg + word emphasis, all three
 * visible together. Split (side-by-side) views serve write/edit and fall back
 * to unified (stacked) on narrow terminals or wrap-heavy hunks (the
 * choice is purely geometric — write and edit share it).
 *
 * Tool registration follows the session lifecycle: each session_start
 * (startup, reload, fork, resume) re-resolves the two-layer config from
 * the callback's ctx.cwd and registers the tool wrappers (skipping any
 * tool the config disables, and yielding grep/find to pi-fff when it is
 * loaded).
 *
 * Theming (ADR 0006): the bundled themes ship as package assets (pi's
 * manifest discovers themes/); resources_discover lists the user's
 * converted pigment-*.json outputs and maps them for ours-detection;
 * the `/pigment convert` command does the manual conversion. Rendering
 * is zero-config: the scheme auto-derives from the active pi theme
 * (a pigment-* theme IS the theme — canvas, boxes, and diff slots baked
 * at generation time) and the syntax tokens follow the detection chain
 * (override > ours > the theme's nine colors).
 */

import {
  type ExtensionContext,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ExtensionAPI,
  getAgentDir,
  SettingsManager,
  type SessionStartEvent,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { registerPigmentCommand } from "#src/command/theme-command.ts";
import type { ToolName } from "#src/config/config-schema.ts";
import type { SessionEnv } from "#src/core/session-env.ts";
import { createRenderKit, publishRenderKit } from "#src/render/kit.ts";
import { listConvertedThemes } from "#src/theme/user-themes.ts";

/**
 * Whether the pi-fff search extension is present — the yield signal for
 * grep/find.
 *
 * Kept as the explicit fast path: the generic occupancy check
 * (claimedByOther below) also catches FFF's override-mode tools, but
 * only when FFF registered before our session_start fires. The command
 * signal fires at module load (before ANY session_start), so it is
 * order-safe where the tool vocabulary is not — and it stays silent,
 * where a generic yield reports. Both stay: explicit for the known
 * neighbor, generic for everyone else.
 *
 * Pi-fff compat: when FFF is loaded, pi-pigment YIELDS the grep/find names
 * in ALL its modes — a same-name registration from pi-pigment (which loads
 * first) would crowd out FFF's override-mode tools (first registration
 * wins the name), silently replacing frecency search with the built-ins.
 * ls is unaffected (FFF has no ls).
 *
 * The presence signal is FFF's `/fff-mode` COMMAND: extensions run their
 * module bodies (commands and flags register there) BEFORE any
 * session_start fires, so this is order-safe and mode-independent —
 * unlike the tool-name vocabulary, which only exists after FFF's own
 * session_start (too late for us) and differs per mode (override
 * registers grep/find, not ffgrep/fffind). The vocabulary stays as a
 * secondary signal for FFF variants without the command.
 * Conservative: tools-and-ui users who manually activate
 * the dormant built-in grep also lose pi-pigment's rendering — but a
 * coexisting renderer silently shadowing another extension's tools is
 * the worse failure, and ADR 0005 keeps activation the user's call.
 *
 * @param tools - Tool names visible at session_start (one snapshot).
 * @param commands - Command names visible at session_start (one snapshot).
 * @returns True when an FFF signal is present.
 */
function fffPresent(tools: readonly string[], commands: readonly string[]): boolean {
  return ["fff-mode", "ffgrep", "fffind"].some(
    (name) => tools.includes(name) || commands.includes(name),
  );
}

/**
 * Whether `name` is already claimed by another extension — the generic
 * yield check. Reads pi's merged registry through `getAllTools`: a tool
 * entry whose source is anything but `builtin` is either another
 * extension's definition or an SDK-passed custom tool, and registering
 * our wrapper under the same name would shadow it (extension
 * registrations win the slot over built-ins, so our wrap is the
 * shadowing one, not the victim). Our own prior registration is excluded
 * by registrant identity — the loader stamps every extension tool with
 * its extension's `sourceInfo` (path + source), so a resume/fork re-fire
 * served from the same registry recognizes our own wrappers without any
 * module-level memory (`ownPath` is this extension's registered path).
 *
 * Order caveat (documented, not worked around): the check only sees
 * tools registered before our session_start fires. A neighbor that
 * loads after us and registers in its own session_start loses the name
 * to us — pi merges by load order, not registration time — no matter
 * what its session_start does afterwards; our wrapper stays live and
 * the only honest signal we can emit is none. The loader logs a name
 * conflict for the dropped registration; three escape hatches remain:
 * the neighbor registers in its factory (visible to us, so we yield),
 * borrows our renderers through the render kit (both render), or the
 * user lists the name in disabledTools.
 *
 * @param tools - Registry entries visible at session_start (one snapshot).
 * @param name - The tool name to probe.
 * @param ownPath - This extension's registered path (self-recognition).
 * @returns True when another extension already owns the name.
 */
function claimedByOther(
  tools: readonly ToolInfo[],
  name: string,
  ownPath: string | undefined,
): boolean {
  // Fail-safe toward keeping our rendering: without our own path we
  // cannot tell our prior wrappers from a neighbor's (a same-named
  // `/pigment` command from another extension renames ours to
  // `pigment:N`, so the lookup misses) — yielding then would disable
  // ourselves on every resume/fork re-fire.
  if (ownPath === undefined) return false;
  return tools.some((tool) => {
    if (tool.name !== name) return false;
    // Unattributed entries cannot be proven foreign — only hand-rolled
    // mocks omit sourceInfo (the SDK always stamps it) — never yield on them.
    const source = tool.sourceInfo?.source;
    if (source === undefined || source === "builtin") return false;
    return tool.sourceInfo.path !== ownPath;
  });
}

/**
 * Wire pi-pigment into the session: resolve the two-layer config and the
 * override selection on every session_start, then register the seven
 * tool wrappers (minus config-disabled tools, the FFF-yielded names,
 * and any name claimedByOther reports as taken). The bundled
 * themes ship as package assets (pi's manifest discovers themes/); the
 * user's theme files convert at resources_discover time.
 *
 * @param pi - The extension API.
 */
export function createPigmentExtension(pi: ExtensionAPI): void {
  // Channel B of the render kit (render-kit.ts): publish the borrowing
  // surface for consumers that do not depend on this package. Idempotent,
  // first publisher wins — a /reload must not replace the object a
  // consumer already holds.
  publishRenderKit();
  // The latest session_start environment — the `/pigment` completer's read
  // (the assembly holds the session value; the command cannot reach ctx).
  let sessionEnv: SessionEnv | undefined;
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    const agentDir = getAgentDir();
    sessionEnv = { cwd, agentDir };
    // Config/theme issues surface through the documented channel — the
    // TUI notification area (or RPC client) when present; stderr only in
    // headless modes (print/json), where it is the visible medium.
    const reportIssue = (message: string): void => {
      if (ctx.hasUI) {
        ctx.ui.notify(`[pi-pigment] ${message}`, "warning");
      } else {
        console.error(`[pi-pigment] ${message}`);
      }
    };
    // The session's kit: the extension decorates through the same
    // surface third parties borrow (kit.decorate), so own rendering and
    // borrowed rendering are byte-identical by construction — the public
    // API is dogfooded, never shadow-implemented.
    const kit = await createRenderKit({ cwd, agentDir, reportIssue });
    const disabledTools = new Set(kit.config.disabledTools);
    // The shell settings pi bakes into its own bash definition
    // (agent-session's `createAllToolDefinitions(cwd, { bash: {
    // commandPrefix, shellPath } })`). Our same-name registration replaces
    // that definition wholesale, execute included, so the wrapper has to
    // carry the same two options or a configured shell/prefix would be
    // silently dropped from the command that actually runs. Same read
    // path — and the same trust gate — as pi's own manager: an untrusted
    // project's `.pi/settings.json` must not shape the executing command.
    // Lazily read: a disabled bash skips the settings I/O entirely.
    let shellSettings: SettingsManager | undefined;

    // One registry snapshot per session_start: the merged registry does
    // not change mid-startup (registrations here only take effect for
    // the runner merge), so every yield check below reads the same
    // frozen view instead of re-querying pi per tool.
    const registryTools = pi.getAllTools();
    const registryToolNames = registryTools.map((tool) => tool.name);
    const registryCommands = pi.getCommands();
    const registryCommandNames = registryCommands.map((command) => command.name);

    // Self-recognition for the yield check: a resume/fork re-fire served
    // from the same registry sees our own prior wrappers as non-builtin
    // entries carrying OUR sourceInfo.path — claimedByOther excludes that
    // path. It is read off our own `/pigment` command (registered at
    // factory time, before any session_start fires): its sourceInfo.path
    // IS this extension's path.
    const ownPath = registryCommands.find((command) => command.name === "pigment")?.sourceInfo.path;

    // A thunk, not a definition: arguments evaluate eagerly, so building
    // inline would pay the decorate cost (bash's SettingsManager I/O)
    // for a tool that never registers.
    const registerToolIfEnabled = (
      toolName: ToolName,
      buildDecorated: () => ToolDefinition | undefined,
    ): void => {
      if (disabledTools.has(toolName)) return;
      const tool = buildDecorated();
      if (!tool) return;
      // Another extension owns this name — skip our wrap (see
      // claimedByOther); reported through the issue channel.
      if (claimedByOther(registryTools, toolName, ownPath)) {
        reportIssue(
          `${toolName} is already provided by another extension — pi-pigment skips its rendering for this tool.`,
        );
        return;
      }
      pi.registerTool(tool);
    };

    // Wrap the DEFINITIONS (not the AgentTool wrappers): the AgentTool
    // wrappers strip renderCall/renderResult, and the SDK's own renderers
    // are delegation targets (bash's native output display; grep's call
    // header). The definitions are generic over their schemas — the
    // wrappers treat orig renderers as unknown-args seams throughout, so
    // the registration widens once, here.
    const decorateBuiltin = (definition: ToolDefinition): ToolDefinition | undefined => {
      const name = definition.name;
      if (!kit.hasTool(name)) return undefined;
      // bash carries pi's shell settings into the executed command (see
      // above) — rebuild its definition with them before decorating.
      if (name === "bash") {
        shellSettings ??= SettingsManager.create(cwd, agentDir, {
          projectTrusted: ctx.isProjectTrusted(),
        });
        return kit.decorate(
          defineTool(
            createBashToolDefinition(cwd, {
              commandPrefix: shellSettings.getShellCommandPrefix(),
              shellPath: shellSettings.getShellPath(),
            }),
          ),
        );
      }
      return kit.decorate(definition);
    };
    registerToolIfEnabled("write", () =>
      decorateBuiltin(defineTool(createWriteToolDefinition(cwd))),
    );
    registerToolIfEnabled("edit", () => decorateBuiltin(defineTool(createEditToolDefinition(cwd))));
    registerToolIfEnabled("bash", () => decorateBuiltin(defineTool(createBashToolDefinition(cwd))));
    const yieldSearchTofff = fffPresent(registryToolNames, registryCommandNames);
    registerToolIfEnabled("grep", () =>
      yieldSearchTofff ? undefined : decorateBuiltin(defineTool(createGrepToolDefinition(cwd))),
    );
    registerToolIfEnabled("ls", () => decorateBuiltin(defineTool(createLsToolDefinition(cwd))));
    registerToolIfEnabled("read", () => decorateBuiltin(defineTool(createReadToolDefinition(cwd))));
    registerToolIfEnabled("find", () =>
      yieldSearchTofff ? undefined : decorateBuiltin(defineTool(createFindToolDefinition(cwd))),
    );
    // PowerShell exists only on Windows (the SDK's shell config throws
    // elsewhere); registering the wrapper is harmless on other platforms —
    // the tool never runs — and gives Windows sessions the same rendering.
    registerToolIfEnabled("powershell", () =>
      decorateBuiltin(defineTool(createPowerShellToolDefinition(cwd))),
    );

    // NOTE on activation: pi's default active set is read/bash/edit/write
    // — grep/find/ls/powershell are REGISTERED but dormant until the user
    // (or a tool extension like pi-fff) activates them. pi-pigment wraps
    // whatever the environment activates (the same-name registration
    // wins the registry slot); it never extends the agent's tool surface
    // itself — that is the user's call, not a renderer's.
  });

  // The registration channel for converted user themes (ADR 0006): the
  // `/pigment convert` command writes outputs next to their sources; this
  // lists them (individual files — the directory also holds TextMate theme sources
  // pi must not load). Pure listing, zero conversion at startup; the
  // ours-detection side of the mapping is collected by the session itself at
  // session_start (autoRenderSession). The bundled themes need no runtime
  // registration — they ship as package assets pi discovers via
  // the manifest's pi.themes entry.
  pi.on("resources_discover", async (_event, ctx: ExtensionContext) => {
    const outputs = listConvertedThemes({ cwd: ctx.cwd, agentDir: getAgentDir() });
    return outputs.length > 0 ? { themePaths: outputs } : {};
  });

  // Manual conversion: /pigment convert [stem] (TUI selector without one).
  registerPigmentCommand(pi, { getEnv: () => sessionEnv });
}
