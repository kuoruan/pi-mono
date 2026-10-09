/**
 * Chat lane adapter: one registry-model attempt behind the pool's
 * three-state seam. Owns model resolution, auth, prompt building, the
 * `reviewModel` call, and the terminalize closure — the raw error never
 * leaves this module.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

import type { AiGuardConfig } from "#src/config/config-schema.ts";
import { PRE_CALL_MACHINERY_KINDS } from "#src/model/machinery-kinds.ts";
import type { ModelRegistryLike, ResolvedRequestAuth } from "#src/model/model-registry.ts";
import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import {
  type ChatInstructions,
  buildReviewPrompt,
  buildReviewSystemPrompt,
} from "#src/review/engines/chat/prompt.ts";
import type { AttemptResult, AttemptSpec, LaneAdapter, PoolEndpoint } from "#src/review/pool.ts";
import type {
  EngineCallContext,
  EngineMachineryFailure,
  EngineReviewResult,
} from "#src/review/reviewer-engine.ts";
import { errorMessage } from "#src/utils.ts";

import { type ModelCallFn, reviewModel } from "./call.ts";

export interface ChatAdapterDeps {
  /** Shared reviewer knobs (reasoning/maxTokens only — thresholds are classifier-scoped). */
  config: {
    reasoning: AiGuardConfig["reasoning"];
    maxTokens: AiGuardConfig["maxTokens"];
    instructions: ChatInstructions;
  };
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
 * Create the chat lane adapter.
 *
 * @param deps - Registry, model-call fn, and the lane-scoped config slice.
 * @returns A `LaneAdapter` attempting one registry model per call.
 */
export function createChatAdapter(deps: ChatAdapterDeps): LaneAdapter {
  const { config } = deps;
  const systemPrompt = buildReviewSystemPrompt(config.instructions);

  return {
    async attempt(
      endpoint: PoolEndpoint,
      ctx: EngineCallContext,
      spec: AttemptSpec,
    ): Promise<AttemptResult> {
      if (endpoint.lane !== "chat") throw new Error("chat adapter received a classifier endpoint");
      const { hasFailover, attemptTimeoutMs } = spec;
      const modelId = endpoint.id;
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
        attemptTimeoutMs,
        // A walk with backups is the retry: only a single-endpoint walk
        // keeps the transport's own retry behavior.
        hasFailover ? 0 : 1,
      );
      if (outcome.availabilityReason) {
        return {
          kind: "retryable",
          reason: outcome.availabilityReason,
          finalize: (): EngineReviewResult => ({ outcome, modelId }),
        };
      }
      return { kind: "answered", result: { outcome, modelId } };
    },
  };
}
