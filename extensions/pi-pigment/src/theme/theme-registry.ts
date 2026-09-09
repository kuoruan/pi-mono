/**
 * The theme registry (ADR 0006): the runtime authority for "which pi
 * themes are OURS and what shiki source each maps back to". Detection
 * reads it; resources_discover feeds it.
 *
 * Two sources:
 *
 * - Bundled: the 65 pre-generated package themes (themes/pigment-*.json, built by
 *   scripts/generate-themes.ts). The mapping is derivable from the naming scheme alone — no I/O.
 * - User: theme files in the config `themes/` directories, converted ON DEMAND by `/pigment convert`
 *   (outputs next to their sources); resources_discover only LISTS the outputs as themePaths. Their
 *   mapping comes from that scan.
 *
 * A pi theme whose name is NOT in the registry is external (built-in,
 * third-party, user-custom, or a copied-and-renamed pi-pigment file): the
 * follower path (auto) applies — its own nine syntax colors, gracefully
 * degraded from full tokenColors precision.
 */

import { isBundledThemeName } from "./bundled-intake.ts";

/** The registered-name prefix (the visible namespace in /theme). */
export const PIGMENT_PREFIX = "pigment-";

/** What a registered name maps back to. */
type RegisteredSource = { kind: "bundled"; themeName: string } | { kind: "user"; fileName: string };

/** The session's registry: name → source (set at session_start). */
const registry = new Map<string, RegisteredSource>();

/**
 * The bundled registration: name scheme alone, no state.
 *
 * @param name - The pi theme name.
 * @returns The bundled source, or undefined when the name is not ours.
 */
function bundledSourceOf(name: string): RegisteredSource | undefined {
  if (!name.startsWith(PIGMENT_PREFIX)) return undefined;
  const themeName = name.slice(PIGMENT_PREFIX.length);
  return isBundledThemeName(themeName) ? { kind: "bundled", themeName } : undefined;
}

/**
 * Register a user TextMate theme file's converted pi theme (called by the
 * resources_discover listing pass).
 *
 * @param fileName - The TextMate theme file's stem (the config-side identity).
 * @param piName - The registered pi theme name.
 */
export function registerUserTheme(fileName: string, piName: string): void {
  registry.set(piName, { kind: "user", fileName });
}

/** Reset the user registrations (test seam; bundled derivations are pure). */
export function resetRegistryForTest(): void {
  registry.clear();
}

/**
 * Whether an active pi theme name is one of ours, and what it maps to.
 *
 * @param name - The active pi theme's name (undefined = not detectable).
 * @returns The registered source, or undefined for external themes.
 */
export function registeredSourceOf(name: string | undefined): RegisteredSource | undefined {
  if (!name) return undefined;
  return registry.get(name) ?? bundledSourceOf(name);
}
