/**
 * Shared ask fixtures: upstream-shaped PromptPayload / evidence / details
 * builders used across the ask and review-request test files.
 * One definition per fixture shape so ask projections can't drift between
 * suites.
 */

import type { PromptPayload, PromptPermissionDetails } from "@gotgenes/pi-permission-system";

/**
 * Evidence entry helper for fixtures.
 *
 * @param label - The evidence label.
 * @param text - The evidence text.
 * @param detail - Optional detail (e.g. an external-path detail).
 * @returns A `PromptEvidence`-shaped entry.
 */
export function ev(label: string, text: string, detail: string | null = null) {
  return { label, text, detail };
}

/**
 * Build a `PromptPayload` with explicit kind + request facts + evidence.
 *
 * @param kind - The payload kind.
 * @param request - Partial request facts (value is required).
 * @param evidence - Evidence entries (default: none).
 * @param annotations - Model annotations (default: none).
 * @returns A complete `PromptPayload`.
 */
export function payload(
  kind: PromptPayload["kind"],
  request: Partial<PromptPayload["request"]> & { value: string },
  evidence: PromptPayload["evidence"] = [],
  annotations: PromptPayload["annotations"] = [],
): PromptPayload {
  return {
    kind,
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash",
      toolName: null,
      invokedToolName: null,
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
      ...request,
    },
    evidence,
    annotations,
  } as PromptPayload;
}

/**
 * Minimal bash payload: sub in `request.value`, full command in evidence.
 *
 * @param sub - The policy-selected sub-command.
 * @param full - Optional full command; adds a `full command` evidence entry.
 * @returns A minimal `PromptPayload` with `kind: "bash"`.
 */
export function bashPayload(sub: string, full?: string): PromptPayload {
  const evidence = full && full !== sub ? [ev("full command", full)] : [];
  return payload("bash", { surface: "bash", value: sub }, evidence);
}

/**
 * Build a `PromptPermissionDetails`-shaped object from overrides.
 *
 * @param overrides - Fields to override (payload, value, surface, …).
 * @returns A complete details object (structurally upstream-shaped).
 */
export function makeDetails(overrides: Record<string, unknown> = {}): PromptPermissionDetails {
  const value = typeof overrides.value === "string" ? overrides.value : "ls -la";
  const payloadOverride = overrides.payload as PromptPayload | undefined;
  return {
    requestId: "test-1",
    source: "tool_call",
    agentName: null,
    surface: "bash",
    value,
    command: value,
    payload: payloadOverride ?? bashPayload(value),
    message: "Run command",
    ...overrides,
  } as unknown as PromptPermissionDetails;
}
