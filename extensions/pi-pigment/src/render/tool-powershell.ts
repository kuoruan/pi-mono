/**
 * The powershell tool wrapper: the shared shell-tool rendering (command
 * colored in PowerShell grammar, output delegated to the SDK's native
 * renderer) with powershell's grammar and prompt. The tool itself only
 * executes on Windows (the SDK's shell config throws elsewhere); the
 * wrapper is registered unconditionally so Windows sessions get the same
 * rendering with no platform branch in the assembly.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createShellWrapper } from "./shell-tool.ts";
import type { ToolServices } from "./tool-services.ts";

/**
 * Build the powershell wrapper around `origPowerShell`.
 *
 * @param origPowerShell - The SDK powershell tool to wrap.
 * @param services - Assembly services.
 * @returns The wrapped tool.
 */
export function createPowerShellWrapper(
  origPowerShell: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  return createShellWrapper(origPowerShell, services, {
    language: "powershell",
    prompt: "PS>",
  });
}
