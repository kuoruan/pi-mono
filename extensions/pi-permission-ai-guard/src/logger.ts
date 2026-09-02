/**
 * Unified logging for the ai-guard extension.
 *
 * Uses console.warn/console.debug with a consistent prefix so logs can be
 * filtered by extension ID. Inside authorize(), prefer the injected
 * AuthorizerLog (log.review/log.debug) instead — it writes to the permission
 * review audit log.
 */

import { EXTENSION_ID, LINK_NAME } from "#src/config/config-schema.ts";

/**
 * Human-facing message prefix for UI notification copy, derived from the
 * authorizer link name (single-sourced with the chain link, never
 * hardcoded). Bracket form avoids the level prefix the host adds to its
 * notifications ("Warning: ...") reading as a doubled "Warning: ai-guard:".
 */
export const NOTIFY_PREFIX = `[${LINK_NAME}]`;

/**
 * The TUI's notification levels (the ui.notify contract, stated directly
 * rather than derived from upstream types — the seam owns its vocabulary).
 */
export type NotifyLevel = "info" | "warning" | "error";

const PREFIX = `[${EXTENSION_ID}]`;

export function warn(message: string): void {
  console.warn(`${PREFIX} ${message}`);
}
