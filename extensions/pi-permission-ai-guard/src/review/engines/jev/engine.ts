import { APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";

import type { TypesafeConfig } from "#src/config/config-schema.ts";
import { emitCallFailure } from "#src/model/model-review.ts";
import type { ModelCallDeferKind, ReviewOutcome } from "#src/model/model-verdict.ts";
import type {
  EngineCallContext,
  EngineMachineryFailure,
  EngineReviewResult,
  ReviewerEngine,
} from "#src/review/reviewer-engine.ts";
import { classifyAbortish } from "#src/utils.ts";

import { type TypesafeClientLike, buildJevRequest, createTypesafeClient } from "./client.ts";
import { projectRawAnswers, synthesizeJevVerdict } from "./verdict.ts";

export interface JevEngineDeps {
  /** The config-schema union's object-provider member (the lifecycle's fan-out selects it). */
  config: TypesafeConfig;
  /**
   * Injected client (tests fake it; production builds the real SDK client eagerly — an unresolvable
   * key/baseUrl throws here, at registration time, not per ask).
   */
  client?: TypesafeClientLike;
  /** Injected clock (tests only). */
  now?: () => number;
}

/**
 * Classify an error into a model call defer kind.
 *
 * @param error - The error to classify.
 * @returns The corresponding model call defer kind.
 */
function classifyError(error: unknown): ModelCallDeferKind {
  if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return "timeout";
  return classifyAbortish(error) ?? "call-failed";
}

/**
 * Create the Jev reviewer engine (the TypeSafe SDK path).
 *
 * @param deps - The engine dependencies.
 * @returns The reviewer engine.
 */
export function createJevEngine(deps: JevEngineDeps): ReviewerEngine {
  const { config } = deps;
  const { typesafe } = config;
  const now = deps.now ?? Date.now;
  const client: TypesafeClientLike = deps.client ?? createTypesafeClient(config.provider);

  return {
    async review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure> {
      const startedAt = now();
      const modelId = `typesafe/${config.model}`;
      const timeoutMs = typesafe.timeoutMs ?? config.timeoutMs;
      try {
        const response = await client.systemOne(
          buildJevRequest(ctx.transcript, ctx.request, config.instructions, config.model),
          { timeout: timeoutMs },
        );
        const outcome: ReviewOutcome = synthesizeJevVerdict(
          projectRawAnswers(response.answers),
          typesafe,
          now() - startedAt,
        );
        outcome.rawReply = JSON.stringify({ answers: response.answers, usage: response.usage });
        return { outcome, modelId };
      } catch (error) {
        const deferKind = classifyError(error);
        emitCallFailure(ctx, deferKind, error);
        return {
          outcome: { verdict: { kind: "defer" }, deferKind, latencyMs: now() - startedAt },
          modelId,
        };
      }
    },
  };
}
