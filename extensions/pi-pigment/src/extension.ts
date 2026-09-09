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
 * is zero-config: the palette auto-derives from the active pi theme
 * (a pigment-* theme IS the theme — canvas, boxes, and diff slots baked
 * at generation time) and the syntax tokens follow the detection chain
 * (override > ours > the theme's nine colors).
 */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ExtensionAPI,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { registerPigmentCommand } from "#src/command/theme-command.ts";
import { loadPigmentConfig } from "#src/config/config-layer.ts";
import type { ToolName } from "#src/config/config-schema.ts";
import { shortPath } from "#src/render/paths.ts";
import { createBashWrapper } from "#src/render/tool-bash.ts";
import { createEditWrapper } from "#src/render/tool-edit.ts";
import { createFindWrapper } from "#src/render/tool-find.ts";
import { createGrepWrapper } from "#src/render/tool-grep.ts";
import { createLsWrapper } from "#src/render/tool-ls.ts";
import { createPowerShellWrapper } from "#src/render/tool-powershell.ts";
import type { ToolServices } from "#src/render/tool-services.ts";
import { createWriteWrapper } from "#src/render/tool-write.ts";
import { setDiffRoots } from "#src/theme/palette.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import { setSyntaxThemeSelection } from "#src/theme/theme-selection.ts";
import {
  listConvertedThemes,
  registerConvertedThemes,
  setUserThemeEnv,
} from "#src/theme/user-themes.ts";

/**
 * Whether the pi-fff search extension is present — the yield signal for
 * grep/find.
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
 * @param pi - The extension API (commands and tools registered so far).
 * @returns True when an FFF signal is present.
 */
function fffPresent(pi: ExtensionAPI): boolean {
  const signals = [
    ...pi.getCommands().map((command) => command.name),
    ...pi.getAllTools().map((tool) => tool.name),
  ];
  return signals.includes("fff-mode") || signals.includes("ffgrep") || signals.includes("fffind");
}

/**
 * Wire pi-pigment into the session: resolve the two-layer config and the
 * override selection on every session_start, then register the seven
 * tool wrappers (minus config-disabled tools and the FFF-yielded names).
 * The bundled themes ship as package assets (pi's manifest discovers
 * themes/); the user's theme files convert at resources_discover time.
 *
 * @param pi - The extension API.
 */
export function createPigmentExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const agentDir = getAgentDir();
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
    const { config, issues } = loadPigmentConfig({ cwd });
    for (const issue of issues) {
      reportIssue(issue.message);
    }
    const disabledTools = new Set(config.disabledTools);
    const {
      selection,
      rootsSpec,
      issues: themeIssues,
    } = await resolveSyntaxThemeSelection(config.syntaxTheme, { cwd, agentDir });
    for (const issue of themeIssues) {
      reportIssue(issue.message);
    }
    setDiffRoots(rootsSpec);
    setSyntaxThemeSelection(selection);
    // The user-theme environment for the registry's lazy reloads (render
    // time has no env of its own).
    setUserThemeEnv({ cwd, agentDir });
    const services: ToolServices = {
      shortPath: (p: string) => shortPath(cwd, p),
      indicatorStyle: config.indicatorStyle,
      textFactory: Text,
    };

    const registerToolIfEnabled = (toolName: ToolName, tool: ToolDefinition | undefined): void => {
      if (tool && !disabledTools.has(toolName)) pi.registerTool(tool);
    };

    // Wrap the DEFINITIONS (not the AgentTool wrappers): the AgentTool
    // wrappers strip renderCall/renderResult, and the SDK's own renderers
    // are delegation targets (bash's native output display; grep's call
    // header). The definitions are generic over their schemas — the
    // wrappers treat orig renderers as unknown-args seams throughout, so
    // the registration widens once, here.
    registerToolIfEnabled(
      "write",
      createWriteWrapper(defineTool(createWriteToolDefinition(cwd)), services),
    );
    registerToolIfEnabled(
      "edit",
      createEditWrapper(defineTool(createEditToolDefinition(cwd)), services),
    );
    registerToolIfEnabled(
      "bash",
      createBashWrapper(defineTool(createBashToolDefinition(cwd)), services),
    );
    const yieldSearchTofff = fffPresent(pi);
    registerToolIfEnabled(
      "grep",
      yieldSearchTofff
        ? undefined
        : createGrepWrapper(defineTool(createGrepToolDefinition(cwd)), services),
    );
    registerToolIfEnabled("ls", createLsWrapper(defineTool(createLsToolDefinition(cwd)), services));
    registerToolIfEnabled(
      "find",
      yieldSearchTofff
        ? undefined
        : createFindWrapper(defineTool(createFindToolDefinition(cwd)), services),
    );
    // PowerShell exists only on Windows (the SDK's shell config throws
    // elsewhere); registering the wrapper is harmless on other platforms —
    // the tool never runs — and gives Windows sessions the same rendering.
    registerToolIfEnabled(
      "powershell",
      createPowerShellWrapper(defineTool(createPowerShellToolDefinition(cwd)), services),
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
  // pi must not load) and populates the ours-detection registry. Pure
  // listing, zero conversion at startup. The bundled themes need no
  // runtime registration — they ship as package assets pi discovers via
  // the manifest's pi.themes entry.
  pi.on("resources_discover", async (_event, ctx) => {
    const env = { cwd: ctx.cwd, agentDir: getAgentDir() };
    registerConvertedThemes(env);
    const outputs = listConvertedThemes(env);
    return outputs.length > 0 ? { themePaths: outputs } : {};
  });

  // Manual conversion: /pigment convert [stem] (TUI selector without one).
  registerPigmentCommand(pi);
}
