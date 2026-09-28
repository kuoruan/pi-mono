/**
 * Pool assembly: turn a validated config into ordered pool endpoints plus
 * lane adapters. The single place the config fans out into the pool —
 * lifecycle and the integration harness share it.
 */

import type { AiGuardConfig, FallbackItem } from "#src/config/config-schema.ts";
import type { ModelCallFn, ModelRegistryLike } from "#src/model/model-review.ts";
import { createJevAdapter } from "#src/review/engines/jev/adapter.ts";
import { type TypesafeClientLike, createTypesafeClient } from "#src/review/engines/jev/client.ts";
import { createLlmAdapter } from "#src/review/engines/llm/adapter.ts";
import type { PoolEndpoint } from "#src/review/pool.ts";
import { FALLBACK_TIMEOUT_DEFAULT_MS, createReviewerPool } from "#src/review/pool.ts";
import type { ReviewerEngine } from "#src/review/reviewer-engine.ts";

export interface PoolAssemblyDeps {
  registry: ModelRegistryLike;
  modelCall: ModelCallFn;
}

/**
 * Resolve the ordered endpoint list: primary first, backups after.
 * Backups take their own timeout or the top-level one — primary-only
 * tuning (`typesafe.timeoutMs`) never leaks onto an unrelated endpoint.
 *
 * @param config - The validated extension config.
 * @returns The ordered endpoints (primary first, backups after).
 */
export function resolvePoolEndpoints(config: AiGuardConfig): PoolEndpoint[] {
  const primaryTimeout =
    typeof config.provider === "object"
      ? (config.typesafe.timeoutMs ?? config.timeoutMs)
      : config.timeoutMs;
  const primary: PoolEndpoint =
    typeof config.provider === "object"
      ? {
          lane: "jev",
          provider: config.provider,
          model: config.model,
          timeoutMs: primaryTimeout,
        }
      : {
          lane: "llm",
          provider: config.provider,
          model: config.model,
          timeoutMs: primaryTimeout,
        };
  return [
    primary,
    ...config.fallbacks.map((entry: FallbackItem): PoolEndpoint => {
      // Fallback default is discounted: backups are usually cheap fast
      // models that need no primary-sized window. Explicit entries win.
      const timeoutMs = entry.timeoutMs ?? Math.min(config.timeoutMs, FALLBACK_TIMEOUT_DEFAULT_MS);
      return typeof entry.provider === "object"
        ? { lane: "jev", provider: entry.provider, model: entry.model, timeoutMs }
        : { lane: "llm", provider: entry.provider, model: entry.model, timeoutMs };
    }),
  ];
}

/**
 * Scope `instructions` per lane: a string feeds both lanes (LLM replaces
 * its built-ins, Jev uses it as shared background); an object overlay
 * feeds Jev endpoints only (LLM endpoints use built-ins); null keeps
 * defaults everywhere.
 *
 * @param config - The validated extension config.
 * @returns The per-lane instructions slices.
 */
export function resolveLaneInstructions(config: AiGuardConfig): {
  llm: string | null;
  jev: AiGuardConfig["instructions"];
} {
  return {
    llm: typeof config.instructions === "string" ? config.instructions : null,
    jev:
      typeof config.instructions === "string" || config.instructions === null
        ? config.instructions
        : typeof config.provider === "object"
          ? config.instructions
          : null,
  };
}

/**
 * Build the pooled reviewer engine for a session. Eagerly constructs every
 * Jev endpoint's SDK client so an unresolvable key/baseUrl throws here —
 * at registration time, not per ask (fail-safe session start).
 *
 * @param config - The validated extension config.
 * @param deps - Registry + model-call fn for the LLM lane.
 * @returns A lane-blind `ReviewerEngine` walking the endpoint list.
 */
export function buildReviewerPool(config: AiGuardConfig, deps: PoolAssemblyDeps): ReviewerEngine {
  const endpoints = resolvePoolEndpoints(config);
  const { llm: llmInstructions, jev: jevInstructions } = resolveLaneInstructions(config);
  // Eager Jev clients keyed by provider identity: fail fast on an
  // unresolvable key/baseUrl, share one client per credential set.
  const jevClients = new Map<string, TypesafeClientLike>();
  for (const endpoint of endpoints) {
    if (endpoint.lane !== "jev") continue;
    const key = `${endpoint.provider.baseUrl ?? ""}\0${endpoint.provider.apiKey ?? ""}`;
    if (!jevClients.has(key)) jevClients.set(key, createTypesafeClient(endpoint.provider));
  }
  return createReviewerPool({
    endpoints,
    adapters: {
      llm: createLlmAdapter({
        config: {
          reasoning: config.reasoning,
          maxTokens: config.maxTokens,
          instructions: llmInstructions,
        },
        registry: deps.registry,
        modelCall: deps.modelCall,
      }),
      jev: createJevAdapter({
        config: { typesafe: config.typesafe, instructions: jevInstructions },
        createClient: (provider) => {
          const key = `${provider.baseUrl ?? ""}\0${provider.apiKey ?? ""}`;
          const client = jevClients.get(key);
          if (!client) throw new Error("unreachable: jev client not prebuilt");
          return client;
        },
      }),
    },
  });
}
