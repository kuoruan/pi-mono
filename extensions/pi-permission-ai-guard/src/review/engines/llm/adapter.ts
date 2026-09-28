/**
 * LLM lane adapter: one registry-model attempt behind the pool's
 * three-state seam. Owns model resolution, auth, prompt building, the
 * `reviewModel` call, and the terminalize closure — the raw error never
 * leaves this module.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

import type { AiGuardConfig } from "#src/config/config-schema.ts";
import {
  type ModelCallFn,
  type ModelRegistryLike,
  type ResolvedRequestAuth,
  reviewModel,
} from "#src/model/model-review.ts";
import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import { buildReviewPrompt, buildReviewSystemPrompt } from "#src/review/engines/llm/prompt.ts";
import { PRE_CALL_MACHINERY_KINDS } from "#src/review/machinery-kinds.ts";
import type { AttemptResult, AttemptSpec, LaneAdapter, PoolEndpoint } from "#src/review/pool.ts";
import type {
  EngineCallContext,
  EngineMachineryFailure,
  EngineReviewResult,
} from "#src/review/reviewer-engine.ts";
import { errorMessage } from "#src/utils.ts";

export interface LlmAdapterDeps {
  /** Shared reviewer knobs (reasoning/maxTokens only — thresholds are Jev-scoped). */
  config: Pick<AiGuardConfig, "reasoning" | "maxTokens" | "instructions"> & {
    instructions: string | null;
  };
  registry: ModelRegistryLike;
  modelCall: ModelCallFn;
}

/**
 * Audit identity: `provider/model`, suffixed with the fallback position.
 *
 * @param provider - The registry provider id.
 * @param model - The model id.
 * @param index - The endpoint position (0 = primary, no suffix).
 * @returns The audit identity string.
 */
function modelIdOf(provider: string, model: string, index: number): string {
  return `${provider}/${model}${index ? ` (fallback ${index})` : ""}`;
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
 * Create the LLM lane adapter.
 *
 * @param deps - Registry, model-call fn, and the lane-scoped config slice.
 * @returns A `LaneAdapter` attempting one registry model per call.
 */
export function createLlmAdapter(deps: LlmAdapterDeps): LaneAdapter {
  const { config } = deps;
  const systemPrompt = buildReviewSystemPrompt(config.instructions);

  return {
    async attempt(
      endpoint: PoolEndpoint,
      ctx: EngineCallContext,
      spec: AttemptSpec,
    ): Promise<AttemptResult> {
      if (endpoint.lane !== "llm") throw new Error("llm adapter received a jev endpoint");
      const { index, singleEndpoint, timeoutMs } = spec;
      const modelId = modelIdOf(endpoint.provider, endpoint.model, index);
      let model: Model<Api> | undefined;
      try {
        model = deps.registry.find(endpoint.provider, endpoint.model);
      } catch {
        model = undefined;
      }
      if (!model) {
        // A vanished registry entry is an availability failure when a
        // backup remains; terminal machinery when it is the last resort.
        const failure: EngineMachineryFailure = {
          ok: false,
          kind: PRE_CALL_MACHINERY_KINDS.modelUnresolved,
          modelId,
        };
        return {
          kind: "retryable",
          modelId,
          reason: "model-unresolved",
          finalize: () => failure,
        };
      }
      const auth = await resolveAuth(deps.registry, model);
      if (!auth.ok) {
        // Auth or access failures are not availability errors: never use a
        // backup to bypass a provider's refusal.
        return {
          kind: "terminal",
          result: {
            ok: false,
            kind: PRE_CALL_MACHINERY_KINDS.authFailed,
            modelId,
            detail: auth.error,
          },
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
        timeoutMs,
        singleEndpoint ? 1 : 0,
      );
      if (outcome.availabilityReason) {
        return {
          kind: "retryable",
          modelId,
          reason: outcome.availabilityReason,
          finalize: (): EngineReviewResult => ({ outcome, modelId }),
        };
      }
      return { kind: "answered", result: { outcome, modelId } };
    },
  };
}
