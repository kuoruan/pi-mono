/**
 * The bash tool wrapper: the shared shell-tool rendering (command colored
 * in shell grammar, output delegated to the SDK's native renderer) with
 * bash's grammar and prompt.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createShellWrapper } from "./shell-tool.ts";
import type { ToolServices } from "./tool-services.ts";

/**
 * Build the bash wrapper around `origBash`.
 *
 * @param origBash - The SDK bash tool to wrap.
 * @param services - Assembly services.
 * @returns The wrapped tool.
 */
export function createBashWrapper(
  origBash: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  return createShellWrapper(origBash, services, { language: "shellscript", prompt: "$" });
}
