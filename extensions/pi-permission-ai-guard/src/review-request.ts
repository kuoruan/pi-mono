/**
 * Immutable per-ask review context.
 *
 * This is the single seam between permission details and both prompt rendering
 * and cache identity. Any fact that affects a verdict must live here.
 */

import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

import { buildActionText } from "./ask-eligibility.ts";

export interface ReviewRequestContext {
  surface: string;
  target: string;
  actionText?: string;
  /** The session working directory, which is the policy containment boundary. */
  cwd: string;
  /**
   * Canonical path boundary from the permission system. Non-null only for
   * path surfaces (upstream: ForwardedAccessFacts.boundaryValue is canonical
   * for path, null for bash/mcp/skill/extension).
   */
  canonicalBoundary?: string;
}

/**
 * Build one self-consistent request snapshot from permission details.
 *
 * @param details - The original permission request details.
 * @param surface - The resolved permission surface.
 * @param target - The policy match value being authorized.
 * @param cwd - The session working directory and policy containment boundary.
 * @returns The complete request context used for prompt rendering and caching.
 */
export function buildReviewRequestContext(
  details: PromptPermissionDetails,
  surface: string,
  target: string,
  cwd: string,
): ReviewRequestContext {
  const rawActionText = buildActionText(details, surface);
  const boundaryValue = details.accessIntent?.boundaryValue;

  return {
    surface,
    target,
    actionText: rawActionText,
    cwd,
    canonicalBoundary:
      typeof boundaryValue === "string" && boundaryValue ? boundaryValue : undefined,
  };
}

/**
 * Build cache material for every fact that affects review semantics.
 *
 * **Never log this value** — it contains raw, unredacted action text (needed
 * for cache-key distinction). The caller must pass it directly to a hash
 * function.
 *
 * @param request - The immutable review request context.
 * @returns A stable serialization for immediate hashing by the caller.
 */
export function reviewRequestCacheMaterial(request: ReviewRequestContext): string {
  return JSON.stringify({
    surface: request.surface,
    target: request.target,
    actionText: request.actionText ?? null,
    cwd: request.cwd,
    canonicalBoundary: request.canonicalBoundary ?? null,
  });
}
