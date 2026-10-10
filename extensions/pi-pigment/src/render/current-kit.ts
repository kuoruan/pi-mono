/**
 * The current-session render kit slot — the one mutable module-level
 * reference the extension's rendering paths read.
 *
 * The extension resolves a fresh kit on every `session_start` (the config
 * layers and the theme selection are session-scoped) and swaps it in here.
 * The resolver and the write-details channel read the slot at call time;
 * before the first `session_start` (or after a failed kit build) it is
 * undefined, which every reader treats as "no pigment rendering — fall
 * through to the next renderer".
 *
 * Why a slot and not a closure: the tool-renderer resolver is registered
 * ONCE at extension load (the SDK collects resolvers at load, before any
 * session exists), so it cannot capture a per-session object. The slot is
 * the seam between the two.
 *
 * The `RenderKit` import is type-only — no runtime cycle with kit.ts
 * (whose module graph reaches the renderers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RenderKit } from "./kit.ts";

let current: RenderKit | undefined;

/**
 * Publish the session's kit. Called by the extension's `session_start`
 * once the kit resolves; a `undefined` clears it (failed build, or an
 * explicit reset).
 *
 * @param kit - The resolved kit, or undefined to clear.
 */
export function setCurrentKit(kit: RenderKit | undefined): void {
  current = kit;
}

/**
 * Read the current session's kit.
 *
 * @returns The kit, or undefined before the first successful
 * `session_start`.
 */
export function currentKit(): RenderKit | undefined {
  return current;
}

/**
 * Register the slot's lifecycle: clear it on both session boundaries, so the
 * invariant documented above (undefined before the first `session_start`,
 * and outside any session) is owned where the slot is defined rather than by
 * the assembly.
 *
 * Call this before the kit build registers its own `session_start` handler —
 * pi runs handlers in registration order, so the clear runs first and the
 * build publishes into a cleared slot. (`session_start` is safe to clear in
 * front of: pi awaits every handler, so no render observes the gap.)
 *
 * @param pi - The extension API.
 */
export function bindCurrentKitBoundaries(pi: ExtensionAPI): void {
  pi.on("session_start", clearForBoundary);
  pi.on("session_shutdown", clearForBoundary);
}

/** The boundary clear — one function so both edges clear identically. */
function clearForBoundary(): void {
  setCurrentKit(undefined);
}

/** Clear the slot (tests only — production swaps it per session_start). */
export function resetCurrentKitForTest(): void {
  current = undefined;
}
