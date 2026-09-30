/**
 * Jev lane adapter: one System One attempt behind the pool's three-state
 * seam. Owns the SDK call, answer projection, verdict synthesis, and the
 * terminalize closure — the raw error never leaves this module.
 *
 * Availability table is shared with the LLM lane (failover switches
 * backends; it is not same-backend retry): quota/payment limits, vanished
 * models (404/410), conflicts (409), rate limits (429), timeouts,
 * connection failures, and server errors switch. Auth/policy refusals
 * and malformed requests are terminal defers for the operator.
 */

import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";

import { emitCallFailure } from "#src/audit/call-failure.ts";
import type { TypesafeConfig } from "#src/config/config-schema.ts";
import type { ModelCallDeferKind, ReviewOutcome } from "#src/model/model-verdict.ts";
import { switchableStatusReason } from "#src/model/model-verdict.ts";
import type {
  AttemptResult,
  AttemptSpec,
  JevPoolEndpoint,
  JevProvider,
  LaneAdapter,
  PoolEndpoint,
} from "#src/review/pool.ts";
import type { EngineCallContext, EngineReviewResult } from "#src/review/reviewer-engine.ts";
import { classifyAbortish } from "#src/utils.ts";

import { type TypesafeClientLike, buildJevRequest, createTypesafeClient } from "./client.ts";
import { projectRawAnswers, synthesizeJevVerdict } from "./verdict.ts";

export interface JevAdapterDeps {
  /** The Jev-scoped config slice (thresholds + instructions overlay). */
  config: Pick<TypesafeConfig, "typesafe" | "instructions">;
  /**
   * Client factory, memoized per provider identity (baseUrl + apiKey).
   * Defaults to the real SDK constructor; tests inject fakes here.
   * Production prebuilds every endpoint's client at registration so an
   * unresolvable key/baseUrl fails fast, not per ask.
   */
  createClient?: (provider: JevProvider) => TypesafeClientLike;
  /** Injected clock (tests only). */
  now?: () => number;
}

/**
 * Audit identity: `typesafe/model`, suffixed with the fallback position.
 *
 * @param model - The Jev model id.
 * @param index - The endpoint position (0 = primary, no suffix).
 * @returns The audit identity string.
 */
function modelIdOf(model: string, index: number): string {
  return `typesafe/${model}${index ? ` (fallback ${index})` : ""}`;
}

/**
 * Classify a failed Jev call into the terminal defer kind.
 *
 * @param error - The thrown SDK error.
 * @returns The defer kind for the terminal record.
 */
function classifyError(error: unknown): ModelCallDeferKind {
  if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return "timeout";
  return classifyAbortish(error) ?? "call-failed";
}

/**
 * Fail over only when the backend could not serve the request. Never turn a
 * valid deny/defer into a second opinion, or resend an invalid request.
 * Table matches the LLM lane: failover switches backends (a different
 * backend has no 409 conflict state), it does not hammer the same one —
 * so 409/425 switch here even though the SDK's own retry never covered them.
 *
 * @param error - The thrown SDK error.
 * @returns The switch reason, or undefined when the failure is terminal.
 */
function failoverReason(error: unknown): ReviewOutcome["availabilityReason"] {
  if (error instanceof APIUserAbortError) return undefined;
  if (error instanceof APIError) return switchableStatusReason(error.status);
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection";
  return classifyAbortish(error) === "timeout" ? "timeout" : undefined;
}

/**
 * Create the Jev lane adapter.
 *
 * @param deps - The Jev-scoped config slice and client factory.
 * @returns A `LaneAdapter` attempting one System One endpoint per call.
 */
export function createJevAdapter(deps: JevAdapterDeps): LaneAdapter {
  const { config } = deps;
  const { typesafe } = config;
  const now = deps.now ?? Date.now;
  const createClient = deps.createClient ?? createTypesafeClient;
  // One construction path: memoize per provider identity so shared
  // credentials reuse a client and per-endpoint models stay distinct.
  const built = new Map<string, TypesafeClientLike>();
  const clientFor = (endpoint: JevPoolEndpoint): TypesafeClientLike => {
    const cacheKey = `${endpoint.provider.baseUrl ?? ""}\0${endpoint.provider.apiKey ?? ""}`;
    let client = built.get(cacheKey);
    if (!client) {
      client = createClient(endpoint.provider);
      built.set(cacheKey, client);
    }
    return client;
  };

  return {
    async attempt(
      endpoint: PoolEndpoint,
      ctx: EngineCallContext,
      spec: AttemptSpec,
    ): Promise<AttemptResult> {
      if (endpoint.lane !== "jev") throw new Error("jev adapter received an llm endpoint");
      const { index, singleEndpoint, timeoutMs } = spec;
      const modelId = modelIdOf(endpoint.model, index);
      const startedAt = now();
      try {
        const response = await clientFor(endpoint).systemOne(
          buildJevRequest(ctx.transcript, ctx.request, config.instructions, endpoint.model),
          {
            timeout: timeoutMs,
            // Preserve SDK retry behavior for existing single-endpoint users.
            ...(singleEndpoint ? {} : { retry: { maxRetries: 0 } }),
          },
        );
        const outcome: ReviewOutcome = synthesizeJevVerdict(
          projectRawAnswers(response.answers),
          typesafe,
          now() - startedAt,
        );
        outcome.rawReply = JSON.stringify({ answers: response.answers, usage: response.usage });
        return { kind: "answered", result: { outcome, modelId } };
      } catch (error) {
        const reason = failoverReason(error);
        // One terminal-defer builder serves both exits: `finalize` runs on
        // exhaustion (backup verdicts stay uncached like the LLM lane),
        // the terminal path ships immediately (primary keeps its default).
        const terminalDefer = (): EngineReviewResult => {
          const deferKind = classifyError(error);
          emitCallFailure(ctx, deferKind, error);
          return {
            outcome: { verdict: { kind: "defer" }, deferKind, latencyMs: now() - startedAt },
            modelId,
          };
        };
        if (reason) {
          return { kind: "retryable", modelId, reason, finalize: terminalDefer };
        }
        // Auth/policy refusals and malformed requests: terminal defer for
        // the operator (never machinery — the Jev lane has no pre-call
        // auth step, so this stays on the defer outcome path).
        return { kind: "terminal", result: terminalDefer() };
      }
    },
  };
}
