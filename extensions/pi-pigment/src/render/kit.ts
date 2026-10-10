/**
 * The session render kit: the internal seam between the extension's
 * session lifecycle and the renderer resolver.
 *
 * A kit is built once per `session_start` (the config layers and the theme
 * selection are session-scoped) and published into the current-kit slot
 * (current-kit.ts); the resolver reads it at call time and asks for the
 * renderer triple of a tool name. There is no public decoration surface —
 * pi's own `registerToolRenderer` closed the upstream gap this kit used to
 * work around, so third parties compose renderers through the SDK, not by
 * importing this module.
 */

import { getAgentDir, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { loadPigmentConfig } from "#src/config/config-layer.ts";
import {
  isToolName,
  TOOL_NAMES,
  type PigmentConfig,
  type ToolName,
} from "#src/config/config-schema.ts";
import { defaultIssueSink, type IssueSink } from "#src/core/issue.ts";

import { shortPath } from "./paths.ts";
import { autoRenderSession } from "./session.ts";
import { bashProfile, createShellRenderer, powershellProfile } from "./shell-tool.ts";
import { createEditRenderer } from "./tool-edit.ts";
import { createFindRenderer } from "./tool-find.ts";
import { createGrepRenderer } from "./tool-grep.ts";
import { createLsRenderer } from "./tool-ls.ts";
import { createReadRenderer } from "./tool-read.ts";
import type { ToolServices } from "./tool-services.ts";
import { createWriteRenderer } from "./tool-write.ts";

/** The kit's inputs: the session environment plus config overrides. */
export interface RenderKitOptions {
  /** The session's working directory (the only required input). */
  cwd: string;
  /** The agent directory (`getAgentDir()` by default; tests override it). */
  agentDir?: string;
  /**
   * Config overrides, applied over the resolved two-layer config.
   * One field (not per-key options) so the surface stays symmetric
   * with config evolution — new keys need no kit change.
   */
  config?: Partial<PigmentConfig>;
  /** The diagnostics sink (one stderr line by default). */
  reportIssue?: IssueSink;
}

/** The per-session render state — one kit per session. */
export interface RenderKit {
  /** The session working directory (the path base renderers and the channel resolve against). */
  readonly cwd: string;
  /**
   * Whether this build can decorate `name` — the renderer table's
   * membership test. Takes a plain string because call sites usually hold
   * `definition.name: string`.
   *
   * @param name - The tool name to check.
   * @returns True when {@link renderersFor} accepts it.
   */
  canDecorate(name: string): boolean;
  /**
   * The effective config (file layers + options.config): the resolver
   * reads `disabledTools` off it without re-reading the config layers.
   */
  readonly config: PigmentConfig;
  /**
   * The renderer triple for `name`, composed over the `orig` renderers the
   * caller delegates to (the renderers the resolver's `next()` yields).
   *
   * @param name - The tool name to build renderers for.
   * @param orig - The renderers to delegate/fall back to.
   * @returns The renderer triple.
   * @throws Error when `name` is not a decoratable tool.
   */
  renderersFor(name: string, orig: ToolRenderers | undefined): ToolRenderers;
}

/**
 * Build the session's kit: resolve the config layers' theme selection and
 * collect the user conversions once, then bind the tool services.
 *
 * @param options - The session environment and optional overrides.
 * @returns The kit (one per session; hold it).
 */
export async function createRenderKit(options: RenderKitOptions): Promise<RenderKit> {
  const { cwd, agentDir = getAgentDir(), reportIssue = defaultIssueSink } = options;
  const { config: fileConfig, issues } = loadPigmentConfig({ cwd, agentDir });
  for (const issue of issues) {
    reportIssue(issue.message);
  }
  // Only defined override keys win — a spread would let an explicit
  // `undefined` key erase the file layer's value.
  const config: PigmentConfig = { ...fileConfig };
  for (const [key, value] of Object.entries(options.config ?? {})) {
    if (value !== undefined) (config as Record<string, unknown>)[key] = value;
  }
  const session = await autoRenderSession({ cwd, agentDir }, config, reportIssue);
  const services: ToolServices = {
    cwd,
    shortPath: (p: string) => shortPath(cwd, p),
    indicatorStyle: config.indicatorStyle,
    headerEllipsis: config.headerEllipsis,
    textFactory: Text,
    render: session,
  };
  return {
    cwd,
    config,
    canDecorate: isToolName,
    renderersFor: (name: string, orig: ToolRenderers | undefined): ToolRenderers =>
      renderersFor(name, orig, services),
  };
}

/** A per-name factory: builds one tool's renderer triple over `orig`. */
type RendererFactory = (orig: ToolRenderers | undefined, services: ToolServices) => ToolRenderers;

/**
 * The renderer factories, one per decoratable name. Keyed by `ToolName`, so
 * TypeScript proves the table covers `TOOL_NAMES` exactly: a name added to
 * the schema without a factory is a missing-property error, and a factory
 * for an unknown name is an invalid key — the name set can never drift from
 * the dispatch. bash and powershell share the shell factory, differing only
 * by profile.
 */
const RENDERER_FACTORIES: Record<ToolName, RendererFactory> = {
  bash: (orig, services) => createShellRenderer(orig, services, bashProfile),
  powershell: (orig, services) => createShellRenderer(orig, services, powershellProfile),
  edit: createEditRenderer,
  write: createWriteRenderer,
  grep: createGrepRenderer,
  find: createFindRenderer,
  ls: createLsRenderer,
  read: createReadRenderer,
};

/**
 * Build pi-pigment's renderer triple for `name`, dispatched through
 * {@link RENDERER_FACTORIES} and composed over `orig`.
 *
 * @param name - The tool name.
 * @param orig - The renderers to delegate/fall back to.
 * @param services - The session's tool services.
 * @returns The renderer triple.
 * @throws Error when the name is not decoratable (the message names it and
 *   lists the available tools).
 */
function renderersFor(
  name: string,
  orig: ToolRenderers | undefined,
  services: ToolServices,
): ToolRenderers {
  if (!isToolName(name)) {
    throw new Error(
      `pi-pigment cannot decorate "${name}" — available tools: ${TOOL_NAMES.join(", ")}.`,
    );
  }
  return RENDERER_FACTORIES[name](orig, services);
}
