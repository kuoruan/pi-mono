/**
 * Ask eligibility & review-target resolution.
 *
 * Decides whether a permission ask qualifies for AI review (the surface matches
 * the configured list) and, if so, what value to review (the review target).
 * Both concerns are pure functions of the ask details + config — no session
 * state, no model, no I/O — so they are testable directly through this seam.
 *
 * `resolveReviewTarget` is the deep interface: one call returns either the
 * resolved `{ surface, target }` or `null` (not eligible). The surface-match
 * glob logic, the exclude-priority rule, and the 6-field target fallback chain
 * are all private implementation behind that one return.
 */

import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

/** A resolved review target: the surface and value being authorized. */
export interface ReviewTarget {
  /** Tool surface (e.g. "bash", "mcp", "skill", or a namespaced tool name). */
  surface: string;
  /** The value being authorized (command, tool name, path, etc.). */
  target: string;
}

/**
 * Resolve the review target for an ask.
 *
 * Returns `{ surface, target }` when the ask's surface matches the configured
 * `surfaces` list AND a non-empty target can be extracted. Otherwise returns
 * a tagged reason: `"surface-unmatched"` (surface missing or not configured)
 * or `"no-target"` (surface matched but no review target could be extracted).
 * The caller uses the reason to decide observability — surface-unmatched is
 * expected config behavior (silent), no-target is an unexpected ask (logged).
 *
 * @param details The permission ask details from the Authorizer chain.
 * @param config The surfaces list to match against (glob patterns).
 * @returns The resolved `{ surface, target }` when eligible, or a tagged reason
 *   (`surface-unmatched` / `no-target`) when not.
 */
export function resolveReviewTarget(
  details: PromptPermissionDetails,
  config: { surfaces: readonly string[] },
): ReviewTarget | { reason: "surface-unmatched" } | { reason: "no-target" } {
  const surface = surfaceOf(details);
  if (!surface) return { reason: "surface-unmatched" };
  if (!matchSurface(config.surfaces, surface)) return { reason: "surface-unmatched" };

  const target = extractTarget(details);
  if (!target) return { reason: "no-target" };

  return { surface, target };
}

/**
 * Extract the surface, preferring the forwarded intent.
 *
 * @param details - The permission ask details.
 * @returns The surface string, or undefined if none is present.
 */
function surfaceOf(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}

/**
 * Check whether `surface` matches the configured surfaces list.
 * Supports glob-style patterns where `*` matches any character sequence:
 *
 * - `*`: match any surface
 * - `namespace:*`: match all tools under a namespace
 * - `*:bar`: match `bar` under any namespace
 * - `*:*`: match any namespaced surface
 * - Exact surface name (e.g. "bash", "mcp")
 * - "!pattern": exclude (negate) a pattern; exclusions take priority over inclusions. Useful for
 *   surfaces like `external_directory` and `path` that pi-permission-system's bounded-delegation
 *   checkpoint downgrades to `defer` regardless of the verdict. Empty array or excludes-only (no
 *   includes) = review nothing.
 *
 * @param configured - The configured surface patterns (glob, with `!` negation).
 * @param surface - The surface to test.
 * @returns True if `surface` matches an included pattern and is not excluded.
 */
function matchSurface(configured: readonly string[], surface: string): boolean {
  const excludes = configured.filter((e) => e.startsWith("!"));
  if (excludes.some((e) => globMatch(e.slice(1), surface))) {
    return false;
  }
  return configured.some((entry) => !entry.startsWith("!") && globMatch(entry, surface));
}

/**
 * Extract the review target (the value being authorized).
 * Fallback chain: accessIntent.matchValues → value → command → path → target → toolName/skillName
 *
 * MatchValues are joined with " | " so the model sees all forms. For non-path
 * surfaces (bash/mcp/skill) matchValues is a single-element array, so joining
 * is a no-op. For the path surface, matchValues is [absolute, cwd-relative,
 * canonical]; the joined form gives the model both the absolute and symlink-
 * resolved paths, eliminating the symlink-blindness of taking only [0].
 * Path is excluded from AI review by default (bounded-delegation checkpoint
 * downgrades it to defer); this only matters when an operator opts path in.
 *
 * @param details - The permission ask details.
 * @returns The extracted review target string, or undefined if no field yielded a value.
 */
function extractTarget(details: PromptPermissionDetails): string | undefined {
  const matchValues = details.accessIntent?.matchValues;
  if (matchValues && matchValues.length > 0) {
    return matchValues.join(" | ");
  }

  if (typeof details.value === "string" && details.value) {
    return details.value;
  }
  if (typeof details.command === "string" && details.command) {
    return details.command;
  }
  if (typeof details.path === "string" && details.path) {
    return details.path;
  }
  if (typeof details.target === "string" && details.target) {
    return details.target;
  }
  if (typeof details.toolName === "string" && details.toolName) {
    return details.toolName;
  }
  if (typeof details.skillName === "string" && details.skillName) {
    return details.skillName;
  }

  return undefined;
}

/**
 * Glob match: `*` matches any character sequence, other chars match literally.
 * Used for surface patterns like `"ns:*"`, `"*:bar"`, `"*:*"`.
 *
 * @param pattern - The glob pattern (with `*` wildcards).
 * @param text - The text to test against.
 * @returns True if `text` matches the glob `pattern`.
 */
function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return pattern === text;
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(text);
}
