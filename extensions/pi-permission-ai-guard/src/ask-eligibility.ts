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
 * Suffix that terminates a bash permission prompt message. Built by
 * `formatAskPrompt()` in pi-permission-system: the message always ends with
 * `... (full command: '...'). Allow this command?`. Checking that the message
 * *ends* with this suffix (not just contains it) prevents misparsing a
 * non-bash message that happens to embed the same framing.
 */
const BASH_PROMPT_SUFFIX = "'). Allow this command?";

/** Prefix introducing the full command inside a bash prompt message. */
const FULL_COMMAND_PREFIX = "full command: '";

/**
 * Build the action-text supplement for the model prompt, if the surface has
 * one.
 *
 * `PromptPermissionDetails` carries the action to review across several
 * fields, but none is a clean, structured “full command” for every surface.
 * This function projects the right field into a single prompt-only string,
 * stripping the UI noise from `message` and avoiding the raw `message` as a
 * fallback.
 *
 * Surface dispatch:
 *
 * - **bash** — `details.message` embeds the full command inside `(full command: '...'). Allow this
 *   command?` when it differs from the policy-selected sub-command. Extract it by requiring the
 *   suffix at the _end_ of the message (so a non-bash message that happens to contain the framing
 *   is never misparsed). When `full command:` is absent (simple command where full === sub-command)
 *   or the message format changed, fall back to `details.command` (the sub-command). Never fall
 *   back to the raw `message`.
 * - **mcp** — `toolInputPreview` is always absent. Return `undefined`; the model receives the
 *   qualified target and decides whether that context is sufficient.
 * - **other surfaces (path tools, extension tools like `web_fetch`, etc.)** — `toolInputPreview` is
 *   populated by pi-permission-system’s `ToolPreviewFormatter` and carries the tool input (e.g.
 *   `input {"url":"…"}`). Return it when non-empty.
 *
 * This is **prompt-only** — it does not affect `checkPermission`, cache keys,
 * or `DecisionRecord`. The authoritative identity for those is `target`
 * (from {@link resolveReviewTarget}).
 *
 * @param details - The permission ask details.
 * @param surface - The resolved permission surface (matches the pipeline’s
 *   authoritative surface, from `accessIntent.surface ?? details.surface`).
 * @returns The action text for the prompt, or `undefined` when the surface
 *   has no supplement beyond `target`.
 */
export function buildActionText(
  details: PromptPermissionDetails,
  surface: string,
): string | undefined {
  if (surface === "bash") {
    const msg = typeof details.message === "string" ? details.message : "";
    // Require the suffix at the END of the message — the bash framing is
    // always terminal (`formatAskPrompt` appends nothing after it). A
    // non-bash message that embeds `full command:` mid-string won’t match.
    if (msg.endsWith(BASH_PROMPT_SUFFIX)) {
      const prefixStart = msg.indexOf(FULL_COMMAND_PREFIX);
      if (prefixStart >= 0) {
        const contentStart = prefixStart + FULL_COMMAND_PREFIX.length;
        const contentEnd = msg.length - BASH_PROMPT_SUFFIX.length;
        // Defense-in-depth: the prefix (`full command: '`) is not a substring
        // of the suffix, so contentStart <= contentEnd always holds when both
        // match. Guard against a future suffix change that breaks this.
        if (contentStart < contentEnd) {
          return msg.slice(contentStart, contentEnd);
        }
      }
    }
    // No `full command:` segment (simple command) or message format changed —
    // fall back to the policy-selected sub-command. Never return raw message.
    return typeof details.command === "string" && details.command ? details.command : undefined;
  }

  // Non-bash surfaces: use toolInputPreview when present. The upstream
  // ToolPreviewFormatter populates it for all non-bash, non-MCP tools (path
  // tools + extension tools like web_fetch). MCP and surfaces without a tool
  // input remain opaque; the review pipeline sends them to the model with the
  // qualified target, and the SAFETY_RULES instruct the model to defer when
  // missing context could change the outcome.
  const preview =
    typeof details.toolInputPreview === "string" ? details.toolInputPreview : undefined;
  return preview && preview.length > 0 ? preview : undefined;
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
