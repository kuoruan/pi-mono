/**
 * Operator-facing notice channel: the ui.notify copy family (prefix,
 * levels, the notify signature) plus the console fallback.
 *
 * Inside authorize(), prefer the injected AuthorizerLog
 * (log.review/log.debug) instead — it writes to the permission
 * review audit log.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { EXTENSION_ID, LINK_NAME } from "#src/config/config-schema.ts";

/**
 * Human-facing message prefix for UI notification copy, derived from the
 * authorizer link name (single-sourced with the chain link, never
 * hardcoded). Bracket form avoids the level prefix the host adds to its
 * notifications ("Warning: ...") reading as a doubled "Warning: ai-guard:".
 */
export const NOTIFY_PREFIX = `[${LINK_NAME}]`;

/** The notification levels pi's `ui.notify` accepts. */
export type NotifyLevel = "info" | "warning" | "error";

/**
 * Fire-and-forget user notification — the host UI context's own notify
 * signature (the extension wraps ctx.ui.notify; absent in headless tests
 * and when no UI context was captured).
 */
export type NotifyFn = ExtensionUIContext["notify"];

const PREFIX = `[${EXTENSION_ID}]`;

export function warn(message: string): void {
  console.warn(`${PREFIX} ${message}`);
}
