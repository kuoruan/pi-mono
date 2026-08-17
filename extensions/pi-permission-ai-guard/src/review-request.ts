/**
 * Immutable per-ask review context — the single seam between permission
 * details and both prompt rendering and cache identity. Any fact that affects
 * a verdict must live here.
 */

import type { AskContext } from "./ask-eligibility.ts";

export interface ReviewRequestContext {
  readonly ask: AskContext;
  target: string;
}

/**
 * Build cache material for every fact that affects review semantics.
 *
 * The field set is a `kind`-agnostic decision-relevant superset: every field
 * that could change a verdict across any of the 9 payload kinds, with absent
 * fields (undefined or empty string) normalized to `null` so a missing fact
 * and an empty fact produce the same key.
 *
 * Excluded by design (do not affect the verdict the model can reach):
 * `matchedPattern`, `invokedToolName`, `requester`, `annotations`, `toolName`,
 * and `surface` (display fields; `kind` + `value` already capture identity).
 *
 * **Never log this value** — it contains raw, unredacted action text (needed
 * for cache-key distinction). The caller must pass it directly to a hash
 * function.
 *
 * @param request - The review request context (ask + target).
 * @returns A stable serialization for immediate hashing by the caller.
 */
export function reviewRequestCacheMaterial(request: ReviewRequestContext): string {
  const { ask } = request;
  return JSON.stringify({
    kind: ask.kind,
    value: normalizeEmpty(ask.request.value),
    target: normalizeEmpty(request.target),
    fullCommand: normalizeEmpty(ask.fullCommand),
    flaggedElements: ask.flaggedElements.map(normalizeEmpty),
    commandContext: ask.request.commandContext,
    executedUnit: normalizeEmpty(ask.request.executedUnit),
    canonicalBoundary: normalizeEmpty(ask.canonicalBoundary),
    workingDirectory: ask.workingDirectory,
    readPath: normalizeEmpty(ask.readPath),
    resolvedAlias: normalizeEmpty(ask.resolvedAlias),
    toolInputPreview: normalizeEmpty(ask.toolInputPreview),
  });
}

/**
 * Normalize an absent (undefined) or empty-string field to `null`.
 *
 * @param value - The field value to normalize.
 * @returns The value when non-empty, else `null`.
 */
function normalizeEmpty(value: string | undefined | null): string | null {
  return value && value.length > 0 ? value : null;
}
