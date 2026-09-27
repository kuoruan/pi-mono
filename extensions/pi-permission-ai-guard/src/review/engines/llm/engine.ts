/**
 * LLM reviewer: the pi ModelRegistry backend behind the ReviewerEngine seam.
 *
 * Owns model resolution, auth, prompt building, the reviewModel call, and the
 * two pre-call machinery outcomes (model-unresolved, auth-failed) — returned
 * tagged for the pipeline's machinery lane.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import type { RegistryConfig } from "#src/config/config-schema.ts";
import {
  type ModelCallFn,
  type ModelRegistryLike,
  type ResolvedRequestAuth,
  reviewModel,
} from "#src/model/model-review.ts";
import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import { buildReviewPrompt, buildReviewSystemPrompt } from "#src/review/engines/llm/prompt.ts";
import { PRE_CALL_MACHINERY_KINDS } from "#src/review/machinery-kinds.ts";
import type {
  EngineCallContext,
  EngineMachineryFailure,
  EngineReviewResult,
  ReviewerEngine,
} from "#src/review/reviewer-engine.ts";
import { errorMessage } from "#src/utils.ts";

export interface LlmEngineDeps {
  /** The config-schema union's string-provider member (the lifecycle's fan-out selects it). */
  config: RegistryConfig;
  registry: ModelRegistryLike;
  modelCall: ModelCallFn;
}

async function resolveAuth(
  registry: ModelRegistryLike,
  model: Model<Api>,
): Promise<ResolvedRequestAuth> {
  try {
    return await registry.getApiKeyAndHeaders(model);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Create the LLM reviewer engine (the ModelRegistry path).
 *
 * @param deps - The engine dependencies.
 * @returns The reviewer engine.
 */
export function createLlmEngine(deps: LlmEngineDeps): ReviewerEngine {
  const { config } = deps;
  const systemPrompt = buildReviewSystemPrompt(config.instructions);
  const endpoints = [
    { provider: config.provider, model: config.model, timeoutMs: config.timeoutMs },
    ...config.fallbacks.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      timeoutMs: entry.timeoutMs ?? config.timeoutMs,
    })),
  ];

  return {
    async review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure> {
      let totalLatencyMs = 0;
      for (const [index, endpoint] of endpoints.entries()) {
        const modelId = `${endpoint.provider}/${endpoint.model}${index ? ` (fallback ${index})` : ""}`;
        let model: Model<Api> | undefined;
        try {
          model = deps.registry.find(endpoint.provider, endpoint.model);
        } catch {
          model = undefined;
        }
        if (!model) {
          if (index + 1 < endpoints.length) {
            ctx.log.review(FALLBACK_EVENT, {
              requestId: ctx.requestId,
              failedEndpoint: index,
              nextEndpoint: index + 1,
              modelId,
              reason: "model-unresolved",
            });
            continue;
          }
          return {
            ok: false,
            kind: PRE_CALL_MACHINERY_KINDS.modelUnresolved,
            modelId,
            detail: modelId,
          };
        }
        const auth = await resolveAuth(deps.registry, model);
        if (!auth.ok) {
          // Auth or access failures are not availability errors: never use a
          // backup to bypass a provider's refusal.
          return {
            ok: false,
            kind: PRE_CALL_MACHINERY_KINDS.authFailed,
            modelId,
            detail: auth.error,
          };
        }
        const outcome: ReviewOutcome = await reviewModel(
          {
            model,
            modelCall: deps.modelCall,
            auth: { apiKey: auth.apiKey, headers: auth.headers },
            reasoning: config.reasoning,
            maxTokens: config.maxTokens,
            log: ctx.log,
            requestId: ctx.requestId,
          },
          systemPrompt,
          buildReviewPrompt(ctx.transcript, ctx.request),
          endpoint.timeoutMs,
          endpoints.length > 1 ? 0 : 1,
        );
        totalLatencyMs += outcome.latencyMs;
        if (outcome.availabilityReason && index + 1 < endpoints.length) {
          ctx.log.review(FALLBACK_EVENT, {
            requestId: ctx.requestId,
            failedEndpoint: index,
            nextEndpoint: index + 1,
            modelId,
            reason: outcome.availabilityReason,
          });
          continue;
        }
        return {
          outcome: { ...outcome, latencyMs: totalLatencyMs },
          modelId,
          ...(index ? { cacheable: false } : {}),
        };
      }
      // The primary model is always present, so the loop always returns.
      throw new Error("unreachable: no LLM endpoints");
    },
  };
}
