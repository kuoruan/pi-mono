/**
 * Classifier adapter tests: error → three-state mapping. Success paths
 * (projection, synthesis) are covered at the verdict/unit level; here
 * each SDK failure pins its disposition: answered (never — failures carry no
 * verdict), retryable (availability failure incl. 409/425 per the unified
 * table), or terminal defer (auth/policy refusals, malformed requests).
 */

import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { APIConnectionError, APIError, APITimeoutError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";
import { createClassifierAdapter } from "#src/review/engines/classifier/adapter.ts";
import type {
  ClassifierClientLike,
  ClassifierSystemOneResponse,
} from "#src/review/engines/classifier/client.ts";
import type { AttemptSpec, ClassifierRegistryEndpoint, PoolEndpoint } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { makeDetails } from "#test/fixtures.ts";

function response(overrides: Record<string, unknown> = {}): ClassifierSystemOneResponse {
  return {
    model: "classifier-test",
    usage: { input_tokens: 10, output_tokens: 0 },
    answers: {
      danger_category: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} },
      intent_match: { type: "noul", noul: 0.9 },
      risk: { type: "score", score: 0.4, confidence: 0.9, legend: {}, probabilities: {} },
      ...overrides,
    } as ClassifierSystemOneResponse["answers"],
  };
}

function recordingLog() {
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const log: AuthorizerLog = {
    review: (event, details) => events.push({ event, details }),
    debug: (event, details) => events.push({ event, details }),
  };
  return { events, log };
}

function attemptContext(log: AuthorizerLog) {
  return {
    transcript: { trustedIntent: ["inspect files"], toolCalls: [], strippedCount: 0 },
    request: { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" },
    log,
    requestId: "classifier-adapter-test",
  };
}

/**
 * Per-attempt spec for adapter tests.
 *
 * @param index - The endpoint position.
 * @param singleEndpoint - Whether this is the only endpoint.
 * @returns The attempt spec.
 */
const spec = (index: number, singleEndpoint: boolean): AttemptSpec => ({
  index,
  singleEndpoint,
  timeoutMs: 5_000,
});

const endpoint = (model = "jev-1.13", timeoutMs = 15000): PoolEndpoint => ({
  lane: "classifier",
  backend: "direct",
  provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
  model,
  timeoutMs,
});

const adapter = (client: ClassifierClientLike) =>
  createClassifierAdapter({
    config: {
      classifier: {
        intentThreshold: 0.5,
        riskThreshold: 0.5,
        confidenceThreshold: 0.5,
      },
      instructions: {},
    },
    createClient: () => client,
  });

const httpError = (status: number) =>
  APIError.fromResponse(status, { error: "no capacity" }, new Headers());

const throwing = (error: Error): ClassifierClientLike => ({
  systemOne: async () => {
    throw error;
  },
});

const safe: ClassifierClientLike = { systemOne: async () => response() };

describe("classifier adapter disposition", () => {
  it("answers a valid allow with the primary identity", async () => {
    const attempt = await adapter(safe).attempt(
      endpoint(),
      attemptContext(recordingLog().log),
      spec(0, true),
    );
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict.kind).toBe("allow");
    expect(attempt.result.modelId).toBe("typesafe/jev-1.13");
    expect(attempt.result.cacheable).toBeUndefined();
  });

  it("answers danger and low-confidence outcomes without failover signal", async () => {
    for (const overrides of [
      { danger_category: { type: "choice", choice: "secrets_credentials", confidence: 0.9 } },
      { risk: { type: "score", score: 0.4, confidence: 0.1 } },
    ]) {
      const attempt = await adapter({ systemOne: async () => response(overrides) }).attempt(
        endpoint(),
        attemptContext(recordingLog().log),
        spec(0, false),
      );
      expect(attempt.kind).toBe("answered");
    }
  });

  it.each([402, 404, 408, 409, 410, 425, 429, 503])(
    "reports retryable on HTTP %i (unified table, 409/425 included)",
    async (status) => {
      const attempt = await adapter(throwing(httpError(status))).attempt(
        endpoint(),
        attemptContext(recordingLog().log),
        spec(0, false),
      );
      expect(attempt.kind).toBe("retryable");
      if (attempt.kind !== "retryable") return;
      expect(attempt.reason).toBe(`http-${status}`);
      expect(attempt.modelId).toBe("typesafe/jev-1.13");
    },
  );

  it("reports retryable on timeouts and connection failures", async () => {
    for (const failure of [new APITimeoutError(5_000), new APIConnectionError("socket hang up")]) {
      const attempt = await adapter(throwing(failure)).attempt(
        endpoint(),
        attemptContext(recordingLog().log),
        spec(0, false),
      );
      expect(attempt.kind).toBe("retryable");
    }
  });

  it.each([400, 401, 403, 422])(
    "reports terminal defer (never machinery) on HTTP %i",
    async (status) => {
      const { events, log } = recordingLog();
      const attempt = await adapter(throwing(httpError(status))).attempt(
        endpoint(),
        attemptContext(log),
        spec(0, false),
      );
      expect(attempt.kind).toBe("terminal");
      if (attempt.kind !== "terminal") return;
      expect(attempt.result).toMatchObject({
        outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
      });
      // Debug emission stays with the terminal path.
      expect(events.map((e) => e.event)).toEqual(["ai_guard.model_call_error"]);
    },
  );

  it("reports terminal defer on unexpected local exceptions", async () => {
    const attempt = await adapter(throwing(new Error("unexpected parsing bug"))).attempt(
      endpoint(),
      attemptContext(recordingLog().log),
      spec(0, false),
    );
    expect(attempt.kind).toBe("terminal");
  });

  it("preserves single-endpoint SDK retry and disables it with backups", async () => {
    const seen: Array<unknown> = [];
    const probe: ClassifierClientLike = {
      systemOne: async (_request, options) => {
        seen.push(options?.retry);
        return response();
      },
    };
    const a = adapter(probe);
    await a.attempt(endpoint(), attemptContext(recordingLog().log), spec(0, true));
    await a.attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(seen).toEqual([undefined, { maxRetries: 0 }]);
  });

  it("sends the endpoint model and timeout per attempt", async () => {
    const requests: Array<{ model: string | undefined; timeout: number | undefined }> = [];
    const probe: ClassifierClientLike = {
      systemOne: async (request, options) => {
        requests.push({ model: request.model, timeout: options?.timeout });
        return response();
      },
    };
    await adapter(probe).attempt(
      endpoint("backup-model", 2000),
      attemptContext(recordingLog().log),
      {
        index: 1,
        singleEndpoint: false,
        timeoutMs: 2000,
      },
    );
    expect(requests).toEqual([{ model: "backup-model", timeout: 2000 }]);
  });
});

describe("classifier adapter incomplete responses", () => {
  // Never answered is malformed, not zero: projection throws and the
  // catch routes to a machinery defer (never allow, in every mode).
  // (A fully-empty answers object is covered at the verdict layer by the
  // projection-throws test — this fixture always carries the base keys.)
  it("reports terminal machinery defer when answers itself is missing", async () => {
    const attempt = await adapter({
      systemOne: async () =>
        ({ ...response(), answers: undefined }) as unknown as ClassifierSystemOneResponse,
    }).attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(attempt.kind).toBe("terminal");
    if (attempt.kind !== "terminal") return;
    expect(attempt.result).toMatchObject({
      outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
    });
  });

  it.each([[{ danger_category: undefined }], [{ risk: undefined }], [{ intent_match: undefined }]])(
    "reports terminal machinery defer on missing answers %j",
    async (overrides) => {
      const attempt = await adapter({
        systemOne: async () => response(overrides as Record<string, unknown>),
      }).attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
      expect(attempt.kind).toBe("terminal");
      if (attempt.kind !== "terminal") return;
      expect(attempt.result).toMatchObject({
        outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
      });
    },
  );

  it("reports terminal machinery defer on a missing reading field", async () => {
    const attempt = await adapter({
      systemOne: async () => response({ risk: { type: "score", confidence: 0.9 } }),
    }).attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(attempt.kind).toBe("terminal");
    if (attempt.kind !== "terminal") return;
    expect(attempt.result).toMatchObject({
      outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
    });
  });

  it("answers model-defer on missing confidence (uncertain, not malformed)", async () => {
    const attempt = await adapter({
      systemOne: async () =>
        response({
          danger_category: { type: "choice", choice: "none" },
          risk: { type: "score", score: 1 },
        }),
    }).attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict).toEqual({ kind: "defer" });
    expect(attempt.result.outcome.deferKind).toBe("model-defer");
  });
});

const registryEndpoint = (): ClassifierRegistryEndpoint => ({
  lane: "classifier",
  backend: "registry",
  provider: "typesafe",
  model: "jev-latest",
  timeoutMs: 15000,
});

describe("classifier registry seam", () => {
  it("routes a registry endpoint through the facade client", async () => {
    // Locks the adapter↔facade joint: the registry endpoint must reach
    // `registryClient` (not `createClient`) and its answers must flow
    // through verdict synthesis to an answered attempt.
    const seen: string[] = [];
    const adapterWithFacade = createClassifierAdapter({
      config: {
        classifier: {
          intentThreshold: 0.5,
          riskThreshold: 0.5,
          confidenceThreshold: 0.5,
        },
        instructions: {},
      },
      registryClient: () => {
        seen.push("facade");
        return safe;
      },
    });
    const attempt = await adapterWithFacade.attempt(
      registryEndpoint(),
      attemptContext(recordingLog().log),
      spec(0, true),
    );
    expect(seen).toEqual(["facade"]);
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict.kind).toBe("allow");
    expect(attempt.result.modelId).toBe("typesafe/jev-latest");
  });

  it("names the registry provider, not the SDK protocol, in the audit identity", async () => {
    // The `typesafe/` prefix names the direct SDK protocol. A registry
    // endpoint is whichever provider Pi resolved, so the audit record has to
    // carry that provider id instead.
    const withFacade = createClassifierAdapter({
      config: {
        classifier: { intentThreshold: 0.5, riskThreshold: 0.5, confidenceThreshold: 0.5 },
        instructions: {},
      },
      registryClient: () => safe,
    });
    const attempt = await withFacade.attempt(
      { ...registryEndpoint(), provider: "cloudflare-workers-ai", model: "classify-v1" },
      attemptContext(recordingLog().log),
      spec(0, true),
    );
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.modelId).toBe("cloudflare-workers-ai/classify-v1");
  });

  it("terminal-defers when a registry endpoint arrives without a facade", async () => {
    // The missing-facade throw lands in the attempt's own try/catch, so
    // it surfaces as a terminal defer (fail-safe: never a throw past
    // the adapter), not a rejection.
    const attempt = await adapter(safe).attempt(
      registryEndpoint(),
      attemptContext(recordingLog().log),
      spec(0, true),
    );
    expect(attempt.kind).toBe("terminal");
    if (attempt.kind !== "terminal") return;
    expect(attempt.result).toMatchObject({ outcome: { deferKind: "call-failed" } });
  });
});

describe("classifier fallback config", () => {
  it("defaults to no backups and requires explicit credentials per backup", () => {
    const parsed = configSchema.parse({
      provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
      model: "jev-1.13",
    });
    expect(parsed.fallbacks).toEqual([]);
    expect(
      configSchema.safeParse({
        provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
        model: "jev-1.13",
        fallbacks: [
          { provider: { type: "typesafe", baseUrl: "https://b.example/api" }, model: "classifier" },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts cross-lane (chat) backups and still bounds the list", () => {
    expect(
      configSchema.safeParse({
        provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
        model: "jev-1.13",
        fallbacks: [{ provider: "anthropic", model: "haiku" }],
      }).success,
    ).toBe(true);
    expect(
      configSchema.safeParse({
        provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
        model: "jev-1.13",
        fallbacks: Array.from({ length: 6 }, () => ({ provider: "anthropic", model: "m" })),
      }).success,
    ).toBe(false);
  });
});
