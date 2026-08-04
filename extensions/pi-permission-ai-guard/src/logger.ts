/**
 * Unified logging for the ai-guard extension.
 *
 * Uses console.warn/console.debug with a consistent prefix so logs can be
 * filtered by extension ID. Inside authorize(), prefer the injected
 * AuthorizerLog (log.review/log.debug) instead — it writes to the permission
 * review audit log.
 */

import { EXTENSION_ID } from "./config-schema.ts";

const PREFIX = `[${EXTENSION_ID}]`;

export function warn(message: string): void {
  console.warn(`${PREFIX} ${message}`);
}

export function debug(message: string): void {
  console.debug(`${PREFIX} ${message}`);
}
