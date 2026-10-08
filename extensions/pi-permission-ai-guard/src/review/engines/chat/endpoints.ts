/**
 * Chat lane endpoint construction. The lane has one backend (pi's model
 * registry text path), so this is the shallowest of the two factories —
 * but it exists so `build-pool.ts` never branches on lane shape.
 */

import type { ChatPoolEndpoint } from "#src/review/pool.ts";

/** The addressing fields every lane reads off a config entry. */
interface LaneTarget {
  provider: string;
  model: string;
  timeoutMs: number;
}

/**
 * Build this lane's endpoint for one config entry (primary or fallback).
 * Every config entry reaches a registry-backed lane — there is no
 * alternative chat transport.
 *
 * @param target - The registry addressing plus the resolved timeout.
 * @returns The chat endpoint.
 */
export function buildChatEndpoint(target: LaneTarget): ChatPoolEndpoint {
  return {
    lane: "chat",
    provider: target.provider,
    model: target.model,
    timeoutMs: target.timeoutMs,
  };
}
