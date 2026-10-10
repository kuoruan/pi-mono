/**
 * The renderer resolver: how pi-pigment's rendering reaches the TUI
 * without pi-pigment owning a single tool.
 *
 * Pi collects `registerToolRenderer` resolvers at extension load and runs
 * them in load order for every tool call, each passing the next resolver
 * (then the built-in renderers) as `next()`. pi-pigment registers exactly
 * one resolver, once. It never registers a tool, never occupies a name,
 * and never touches execution.
 *
 * The ordered yield rules live in the gate module (`gate.shouldYield`), so
 * this file only owns the no-kit fail-safe and the delegate-or-decorate
 * step:
 *
 * 1. No kit yet (before the first `session_start`, or a failed build) → `next()` (fail-safe to pi's
 *    own rendering);
 * 2. Otherwise `shouldYield` decides — an unknown name, a name another extension owns, pi-fff present
 *    for grep/find, or a name in `disabledTools` all yield to `next()`;
 * 3. The name survives every gate → build the renderer triple over `next()`, falling back to it when
 *    the build throws.
 *
 * The kit is read per call from the current-kit slot (current-kit.ts),
 * which a `session_start` fills; a resume/fork re-fire simply swaps the
 * kit, so the same resolver serves every session.
 */

import type {
  ExtensionAPI,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";

import { currentKit } from "./current-kit.ts";
import { shouldYield } from "./gate.ts";

/**
 * Build the resolver closure over `pi` (the live registry surface the
 * yield gates read).
 *
 * The registry snapshot (`getAllTools`/`getCommands`) is taken per call,
 * never cached: pi exposes no registry revision to key a cache on, so a
 * cache could serve a stale yield — the very failure ADR 0005 exists to
 * prevent. The cost is one snapshot array per tool call, sub-microsecond
 * against the tool's own execution.
 *
 * @param pi - The extension API.
 * @returns The tool renderer resolver.
 */
export function createPigmentToolRendererResolver(pi: ExtensionAPI): ToolRendererResolver {
  return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
    const kit = currentKit();
    if (kit === undefined) return next();
    if (shouldYield(toolName, kit, pi.getAllTools(), pi.getCommands())) return next();
    // Resolve the chain once, then compose over it. A throw from our own
    // factories returns the resolved value untouched: pi's
    // resolveToolRenderers has no try/catch, so an escaping throw would
    // surface as an unhandled exception in the TUI's render dispatch.
    const orig = next();
    try {
      return kit.renderersFor(toolName, orig);
    } catch {
      return orig;
    }
  };
}

/**
 * Register the resolver. Called once at extension load.
 *
 * @param pi - The extension API.
 */
export function registerPigmentToolRenderers(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createPigmentToolRendererResolver(pi));
}
