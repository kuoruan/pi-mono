/**
 * The theme registry (ADR 0006): the name→source mapping deciding "which pi
 * themes are OURS and what shiki source each maps back to".
 *
 * Two sources:
 *
 * - Bundled: the 65 pre-generated package themes (themes/pigment-*.json, built by
 *   scripts/generate-themes.ts). The mapping is derivable from the naming scheme alone — no I/O
 *   (`bundledSourceOf`).
 * - User: theme files in the config `themes/` directories, converted ON DEMAND by `/pigment convert`
 *   (outputs next to their sources). The session collects each output whose source is still live
 *   (`collectConvertedThemes`) and the rows ride the session as a value.
 *
 * A pi theme whose name is NOT in the mapping is external (built-in,
 * third-party, user-custom, or a copied-and-renamed pi-pigment file): the
 * follower path (auto) applies — its own nine syntax colors, gracefully
 * degraded from full tokenColors precision.
 */

import { isBundledThemeName } from "./bundled-intake.ts";

/** The registered-name prefix (the visible namespace in /theme). */
export const PIGMENT_PREFIX = "pigment-";

/** What a registered name maps back to. */
type RegisteredSource = { kind: "bundled"; themeName: string } | { kind: "user"; fileName: string };

/**
 * One of the session's user conversions: the converted output's stem plus
 * its still-live source file. `collectConvertedThemes` collects these at
 * session_start; the session hands them to ours-detection as a value.
 */
export interface ConvertedTheme {
  /** The registered pi theme name (`pigment-<stem>`, the output file's stem). */
  name: string;
  /** The source file's stem, as `loadUserTheme` reads it (the config-side identity). */
  stem: string;
}

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
 * Whether an active pi theme name is one of ours, and what it maps to.
 *
 * @param name - The active pi theme's name (undefined = not detectable).
 * @param converted - The session's collected user conversions.
 * @returns The registered source, or undefined for external themes.
 */
export function registeredSourceOf(
  name: string | undefined,
  converted: ReadonlyArray<ConvertedTheme>,
): RegisteredSource | undefined {
  if (!name) return undefined;
  const found = converted.find((entry) => entry.name === name);
  if (found) return { kind: "user", fileName: found.stem };
  return bundledSourceOf(name);
}
