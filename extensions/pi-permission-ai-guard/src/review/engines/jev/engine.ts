import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
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
  /** The config-schema union's object-provider member. */
  config: TypesafeConfig;
  /** Injected primary client (tests fake it; production builds the real SDK client eagerly). */
  client?: TypesafeClientLike;
  /** Injected fallback clients in config order (tests only). */
  fallbackClients?: TypesafeClientLike[];
  /** Injected clock (tests only). */
  now?: () => number;
}

/**
 * Classify a failed Jev call.
 *
 * @param error - Error from the SDK.
 * @returns The model call defer kind.
 */
function classifyError(error: unknown): ModelCallDeferKind {
  if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return "timeout";
  return classifyAbortish(error) ?? "call-failed";
}

/**
 * Fail over only when the backend could not serve the request. Never turn a
 * valid deny/defer into a second opinion, or resend an invalid request.
 *
 * @param error - The primary or fallback call failure.
 * @returns A safe audit reason, or undefined when failover is inappropriate.
 */
function fallbackReason(error: unknown): string | undefined {
  if (error instanceof APIUserAbortError) return undefined;
  if (error instanceof APIError) {
    const status = error.status;
    // Auth/policy refusals and malformed requests need an operator. A 404/410
    // may mean a free model vanished, so try the explicitly trusted backup.
    // 409 is deliberately excluded: the SDK's own retry policy never covered
    // it, so a conflict surfaces to the operator instead of switching vendors.
    if ([402, 404, 408, 410, 429].includes(status) || status >= 500) {
      return `http-${status}`;
    }
    return undefined;
  }
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection";
  return classifyAbortish(error) === "timeout" ? "timeout" : undefined;
}

/**
 * Create the Jev reviewer engine. Fallbacks are ordered System One endpoints,
 * not alternative votes: the first valid reply decides. With fallbacks active,
 * each endpoint gets one SDK attempt so an exhausted primary does not consume
 * three attempts before reaching the next provider.
 *
 * @param deps - The engine dependencies.
 * @returns The reviewer engine.
 */
export function createJevEngine(deps: JevEngineDeps): ReviewerEngine {
  const { config } = deps;
  const { typesafe } = config;
  const now = deps.now ?? Date.now;
  const primary = deps.client ?? createTypesafeClient(config.provider);
  const endpoints = [
    { model: config.model, timeoutMs: typesafe.timeoutMs ?? config.timeoutMs, client: primary },
    ...config.fallbacks.map((entry, index) => ({
      model: entry.model,
      // Backups stand in for the primary, so they take the top-level timeout —
      // primary-only tuning must not leak onto an unrelated
      // (possibly third-party) endpoint.
      timeoutMs: entry.timeoutMs ?? config.timeoutMs,
      client: deps.fallbackClients?.[index] ?? createTypesafeClient(entry.provider),
    })),
  ];

  return {
    async review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure> {
      const startedAt = now();
      for (const [index, endpoint] of endpoints.entries()) {
        const modelId = `typesafe/${endpoint.model}${index ? ` (fallback ${index})` : ""}`;
        try {
          const response = await endpoint.client.systemOne(
            buildJevRequest(ctx.transcript, ctx.request, config.instructions, endpoint.model),
            {
              timeout: endpoint.timeoutMs,
              // Preserve SDK retry behavior for existing single-endpoint users.
              ...(endpoints.length > 1 ? { retry: { maxRetries: 0 } } : {}),
            },
          );
          const outcome: ReviewOutcome = synthesizeJevVerdict(
            projectRawAnswers(response.answers),
            typesafe,
            now() - startedAt,
          );
          outcome.rawReply = JSON.stringify({ answers: response.answers, usage: response.usage });
          return { outcome, modelId, ...(index ? { cacheable: false } : {}) };
        } catch (error) {
          const reason = fallbackReason(error);
          if (reason && index + 1 < endpoints.length) {
            // No URL, credential or upstream error body enters the review log.
            ctx.log.review(FALLBACK_EVENT, {
              requestId: ctx.requestId,
              failedEndpoint: index,
              nextEndpoint: index + 1,
              modelId,
              reason,
            });
            continue;
          }
          const deferKind = classifyError(error);
          emitCallFailure(ctx, deferKind, error);
          return {
            outcome: { verdict: { kind: "defer" }, deferKind, latencyMs: now() - startedAt },
            modelId,
          };
        }
      }
      // The primary endpoint is always present, so the loop always returns.
      throw new Error("unreachable: no Jev endpoints");
    },
  };
}
