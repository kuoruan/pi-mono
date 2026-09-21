/**
 * LLM reviewer: the pi ModelRegistry backend behind the ReviewerEngine seam.
 *
 * Owns model resolution, auth, prompt building, the reviewModel call, and the
 * two pre-call machinery outcomes (model-unresolved, auth-failed) — returned
 * tagged for the pipeline's machinery lane.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

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
  const modelId = `${config.provider}/${config.model}`;

  return {
    async review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure> {
      let model: Model<Api> | undefined;
      try {
        model = deps.registry.find(config.provider, config.model);
      } catch {
        model = undefined;
      }
      if (!model) {
        return {
          ok: false,
          kind: PRE_CALL_MACHINERY_KINDS.modelUnresolved,
          modelId,
          detail: modelId,
        };
      }
      const auth = await resolveAuth(deps.registry, model);
      if (!auth.ok) {
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
        config.timeoutMs,
      );
      return { outcome, modelId };
    },
  };
}
