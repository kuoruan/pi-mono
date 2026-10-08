/**
 * Classifier lane adapter: one System One attempt behind the pool's three-state
 * seam. Owns the SDK call, answer projection, verdict synthesis, and the
 * terminalize closure — the raw error never leaves this module.
 *
 * Availability table is shared with the chat lane (failover switches
 * backends; it is not same-backend retry): quota/payment limits, vanished
 * models (404/410), conflicts (409), rate limits (429), timeouts,
 * connection failures, and server errors switch. Auth/policy refusals
 * and malformed requests are terminal defers for the operator.
 */

import { emitCallFailure } from "#src/audit/call-failure.ts";
import type { DirectProviderConfig } from "#src/config/config-schema.ts";
import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import { classifyFailure, failoverReason } from "#src/review/failure-taxonomy.ts";
import type {
  AttemptResult,
  AttemptSpec,
  ClassifierPoolEndpoint,
  ClassifierProvider,
  ClassifierRegistryEndpoint,
  LaneAdapter,
  PoolEndpoint,
} from "#src/review/pool.ts";
import { withFallbackIndex } from "#src/review/pool.ts";
import type { EngineCallContext, EngineReviewResult } from "#src/review/reviewer-engine.ts";

import { type ClassifierClientLike, buildClassifierRequest, createDirectClient } from "./client.ts";
import { directKey } from "./endpoints.ts";
import type { ClassifierOverlay } from "./instructions.ts";
import { projectClassifierAnswers, synthesizeClassifierVerdict } from "./verdict.ts";

export interface ClassifierAdapterDeps {
  /** The classifier-scoped config slice (thresholds + resolved instructions). */
  config: {
    classifier: DirectProviderConfig["classifier"];
    instructions: ClassifierOverlay;
  };
  /**
   * Client factory, memoized per provider identity (baseUrl + apiKey).
   * Defaults to the real SDK constructor; tests inject fakes here.
   * Production prebuilds every direct endpoint's client at registration
   * so an unresolvable key/baseUrl fails fast, not per ask. Registry
   * endpoints never reach this factory — use `registryClient` instead.
   */
  createClient?: (provider: ClassifierProvider) => ClassifierClientLike;
  /**
   * Registry client factory for `backend: "registry"` endpoints: receives
   * the resolved endpoint and returns a `ClassifierClientLike` facade over
   * `modelRegistry.classify`. Production prebuilds one facade per registry
   * endpoint at registration, so per-ask resolution never throws here.
   */
  registryClient?: (endpoint: ClassifierRegistryEndpoint) => ClassifierClientLike;
  /** Injected clock (tests only). */
  now?: () => number;
}

/**
 * Create the classifier lane adapter.
 *
 * @param deps - The classifier-scoped config slice and client factory.
 * @returns A `LaneAdapter` attempting one System One endpoint per call.
 */
export function createClassifierAdapter(deps: ClassifierAdapterDeps): LaneAdapter {
  const { config } = deps;
  const { classifier } = config;
  const now = deps.now ?? Date.now;
  const createClient = deps.createClient ?? createDirectClient;
  // One construction path: memoize per provider identity so shared
  // credentials reuse a client and per-endpoint models stay distinct.
  // Direct backends only — registry endpoints never reach createClient
  // (the facade resolves them through the model registry instead).
  const built = new Map<string, ClassifierClientLike>();
  const clientFor = (endpoint: ClassifierPoolEndpoint): ClassifierClientLike => {
    if (endpoint.backend === "registry") {
      const facade = deps.registryClient;
      if (!facade)
        throw new Error("classifier adapter received a registry endpoint without a facade");
      return facade(endpoint);
    }
    const cacheKey = directKey(endpoint.provider);
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
      if (endpoint.lane !== "classifier")
        throw new Error("classifier adapter received a chat endpoint");
      const { index, singleEndpoint, timeoutMs } = spec;
      // The audit identity names the model that answered: a registry endpoint
      // carries Pi's own provider id, while the direct backend is the SDK
      // protocol (`typesafe`) whatever the model.
      const idPrefix = endpoint.backend === "registry" ? endpoint.provider : "typesafe";
      const modelId = withFallbackIndex(`${idPrefix}/${endpoint.model}`, index);
      const startedAt = now();
      try {
        const response = await clientFor(endpoint).systemOne(
          buildClassifierRequest(ctx.transcript, ctx.request, config.instructions, endpoint.model),
          {
            timeout: timeoutMs,
            // Preserve SDK retry behavior for existing single-endpoint users.
            ...(singleEndpoint ? {} : { retry: { maxRetries: 0 } }),
          },
        );
        const outcome: ReviewOutcome = synthesizeClassifierVerdict(
          projectClassifierAnswers(response.answers),
          classifier,
          now() - startedAt,
        );
        outcome.rawReply = JSON.stringify({ answers: response.answers, usage: response.usage });
        return { kind: "answered", result: { outcome, modelId } };
      } catch (error) {
        const reason = failoverReason(error);
        // One terminal-defer builder serves both exits: `finalize` runs on
        // exhaustion (backup verdicts stay uncached like the chat lane),
        // the terminal path ships immediately (primary keeps its default).
        const terminalDefer = (): EngineReviewResult => {
          const deferKind = classifyFailure(error);
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
        // the operator (never machinery — the classifier lane has no pre-call
        // auth step, so this stays on the defer outcome path).
        return { kind: "terminal", result: terminalDefer() };
      }
    },
  };
}
