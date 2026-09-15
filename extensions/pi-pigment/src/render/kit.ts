/**
 * The public render kit: what a third-party extension imports to borrow
 * pi-pigment's rendering for its own tool definitions — ADR 0005's
 * "yield + lend" (pi-pigment never claims a name another extension owns;
 * the owner borrows the renderers instead).
 *
 * Two channels, one implementation:
 *
 * - Import channel (A): `pi-pigment/render-kit`.
 * - Publication channel (B): `publishRenderKit()` puts the same functions on
 *   `globalThis[Symbol.for(RENDER_KIT_KEY)]`, so a consumer that does not depend on the package
 *   (and cannot import it) can still find them at its own `session_start` (all extension factories
 *   have run by then; a module top-level read would be too early).
 *
 * B is a thin publication of A — never a second API.
 */

import { getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { loadPigmentConfig } from "#src/config/config-layer.ts";
import { TOOL_NAMES, type IndicatorStyle, type ToolName } from "#src/config/config-schema.ts";
import { defaultIssueSink, type IssueSink } from "#src/core/issue.ts";
import { PACKAGE_VERSION } from "#src/package-json.ts";

import { shortPath } from "./paths.ts";
import {
  autoRenderSession,
  createRenderSession,
  type RenderSession,
  type RenderSessionInputs,
} from "./session.ts";
import { createBashWrapper } from "./tool-bash.ts";
import { createEditWrapper } from "./tool-edit.ts";
import { createFindWrapper } from "./tool-find.ts";
import { createGrepWrapper } from "./tool-grep.ts";
import { createLsWrapper } from "./tool-ls.ts";
import { createPowerShellWrapper } from "./tool-powershell.ts";
import type { ToolServices } from "./tool-services.ts";
import { createWriteWrapper } from "./tool-write.ts";

/** The `globalThis` symbol key of channel B (`Symbol.for(RENDER_KIT_KEY)`). */
export const RENDER_KIT_KEY: string = "pi-pigment.render-kit.v1";

/** The protocol version of the publication contract — the payload's `version`. */
export const RENDER_KIT_PROTOCOL_VERSION: number = 1;

/** The kit's inputs: the session environment plus two overrides. */
export interface RenderKitOptions {
  /** The session's working directory (the only required input). */
  cwd: string;
  /** The agent directory (`getAgentDir()` by default; tests override it). */
  agentDir?: string;
  /** The change-indicator style (the config layer's value by default). */
  indicatorStyle?: IndicatorStyle;
  /** The diagnostics sink (one stderr line by default). */
  reportIssue?: IssueSink;
}

/** The borrowed rendering surface — one kit per session. */
export interface RenderKit {
  /** The tool names this build can decorate. */
  readonly tools: readonly ToolName[];
  /**
   * The session's resolved render state, for consumers that render outside
   * a tool slot (e.g. a message renderer): `kit.session.forTheme(theme)`.
   * Constructing a second session for that would re-read the config layers
   * and re-report their issues.
   */
  readonly session: RenderSession;
  /**
   * The `definition` with pi-pigment's renderers installed, dispatched by
   * `definition.name`. Execution is untouched (except `write`, whose
   * `execute` is delegated to and then annotated with the old/new diff in
   * `result.details`).
   *
   * Throws on a name this build cannot decorate — a silently undecorated
   * definition would look like it worked. Find the name in {@link tools}
   * first when the call site is an access-control decision (a throw means
   * the registration never happens, and the built-in tool runs unguarded).
   *
   * @param definition - The extension's own tool definition.
   * @returns The decorated definition (renderers replaced; everything else
   * is the caller's).
   * @throws Error when `definition.name` is not a decoratable tool.
   */
  decorate(definition: ToolDefinition): ToolDefinition;
}

/**
 * Build the session's kit: resolve the config layers' theme selection and
 * collect the user conversions once, then bind the tool services.
 *
 * @param options - The session environment and optional overrides.
 * @returns The kit (one per session; hold it).
 */
export async function createRenderKit(options: RenderKitOptions): Promise<RenderKit> {
  const { cwd, agentDir = getAgentDir(), indicatorStyle, reportIssue = defaultIssueSink } = options;
  const { config, issues } = loadPigmentConfig({ cwd, agentDir });
  for (const issue of issues) reportIssue(issue.message);
  const session = await autoRenderSession({ cwd, agentDir }, config, reportIssue);
  const services: ToolServices = {
    shortPath: (p: string) => shortPath(cwd, p),
    indicatorStyle: indicatorStyle ?? config.indicatorStyle,
    textFactory: Text,
    render: session,
  };
  return {
    tools: TOOL_NAMES,
    session,
    decorate: (definition: ToolDefinition): ToolDefinition => decorate(definition, services),
  };
}

/**
 * Install pi-pigment's renderers on `definition`, dispatched by name.
 *
 * @param definition - The extension's own tool definition.
 * @param services - The session's tool services.
 * @returns The decorated definition.
 * @throws Error when the name is not decoratable (the message names it and
 *   lists the available tools).
 */
function decorate(definition: ToolDefinition, services: ToolServices): ToolDefinition {
  switch (definition.name) {
    case "bash":
      return createBashWrapper(definition, services);
    case "powershell":
      return createPowerShellWrapper(definition, services);
    case "edit":
      return createEditWrapper(definition, services);
    case "write":
      return createWriteWrapper(definition, services);
    case "grep":
      return createGrepWrapper(definition, services);
    case "find":
      return createFindWrapper(definition, services);
    case "ls":
      return createLsWrapper(definition, services);
    default:
      throw new Error(
        `pi-pigment cannot decorate "${definition.name}" — available tools: ${TOOL_NAMES.join(", ")}.`,
      );
  }
}

/**
 * What {@link publishRenderKit} puts on the global channel: the object a
 * zero-dependency consumer reads and checks the protocol version of.
 */
export interface RenderKitPublication {
  /** The protocol version ({@link RENDER_KIT_PROTOCOL_VERSION}). */
  version: number;
  /** The package version, for diagnostics (read from package.json). */
  packageVersion: string;
  /** The decoratable tool names. */
  tools: readonly ToolName[];
  /** Channel A's factory, published for consumers that cannot import. */
  createRenderKit: (options: RenderKitOptions) => Promise<RenderKit>;
  /** Channel A's pure seam factory. */
  createRenderSession: (inputs: RenderSessionInputs) => RenderSession;
}

/**
 * Publish channel B (idempotent, first publisher wins — `/reload` must not
 * replace the object a consumer already holds). Called by the extension at
 * load; consumers read it inside their own `session_start`.
 */
export function publishRenderKit(): void {
  const payload: RenderKitPublication = {
    version: RENDER_KIT_PROTOCOL_VERSION,
    packageVersion: PACKAGE_VERSION,
    tools: TOOL_NAMES,
    createRenderKit,
    createRenderSession,
  };
  (globalThis as Record<symbol, unknown>)[Symbol.for(RENDER_KIT_KEY)] ??= payload;
}
