import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { APIConnectionError, APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import { configSchema, hasTypesafeProvider } from "#src/config/config-schema.ts";
import type {
  TypesafeClientLike,
  TypesafeSystemOneResponse,
} from "#src/review/engines/jev/client.ts";
import { createJevEngine } from "#src/review/engines/jev/engine.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";
import { makeDetails } from "#test/fixtures.ts";

const connection = (name: string) => ({
  type: "typesafe" as const,
  baseUrl: `https://${name}.example/api`,
  apiKey: `${name}-key`,
});

function config(fallbackCount = 1) {
  const parsed = configSchema.parse({
    provider: connection("primary"),
    model: "jev-1.13",
    fallbacks: Array.from({ length: fallbackCount }, (_, i) => ({
      provider: connection(`backup-${i + 1}`),
      model: `backup-model-${i + 1}`,
      timeoutMs: 2000,
    })),
  });
  if (!hasTypesafeProvider(parsed)) throw new Error("expected Jev config");
  return parsed;
}

function response(overrides: Record<string, unknown> = {}): TypesafeSystemOneResponse {
  return {
    model: "jev-test",
    usage: { input_tokens: 10, output_tokens: 0 },
    answers: {
      danger_category: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} },
      intent_match: { type: "noul", noul: 0.9 },
      risk: { type: "score", score: 0.4, confidence: 0.9, legend: {}, probabilities: {} },
      ...overrides,
    } as TypesafeSystemOneResponse["answers"],
  };
}

function reviewContext(log: AuthorizerLog) {
  return {
    transcript: { trustedIntent: ["inspect files"], toolCalls: [], strippedCount: 0 },
    request: { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" },
    log,
    requestId: "fallback-test",
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

const httpError = (status: number) =>
  APIError.fromResponse(status, { error: "no capacity" }, new Headers());

function throwingClient(error: Error): TypesafeClientLike {
  return {
    systemOne: async () => {
      throw error;
    },
  };
}

const safeClient: TypesafeClientLike = { systemOne: async () => response() };

describe("Jev System One fallback", () => {
  it("leaves the backup idle when the primary returns a valid allow", async () => {
    let calls = 0;
    const { events, log } = recordingLog();
    const engine = createJevEngine({
      config: config(),
      client: safeClient,
      fallbackClients: [
        {
          systemOne: async () => {
            calls++;
            return response();
          },
        },
      ],
    });
    const result = await engine.review(reviewContext(log));
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("typesafe/jev-1.13");
    expect(result.cacheable).toBeUndefined();
    expect(calls).toBe(0);
    expect(events).toEqual([]);
  });

  it("switches on a quota error and attributes the uncached verdict to the backup", async () => {
    const { events, log } = recordingLog();
    const requests: Array<{
      model: string | undefined;
      timeout: number | undefined;
      retries: number | undefined;
    }> = [];
    const engine = createJevEngine({
      config: config(),
      client: {
        systemOne: async (request, options) => {
          requests.push({
            model: request.model,
            timeout: options?.timeout,
            retries: options?.retry?.maxRetries,
          });
          throw httpError(429);
        },
      },
      fallbackClients: [
        {
          systemOne: async (request, options) => {
            requests.push({
              model: request.model,
              timeout: options?.timeout,
              retries: options?.retry?.maxRetries,
            });
            return response();
          },
        },
      ],
    });
    const result = await engine.review(reviewContext(log));
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("typesafe/backup-model-1 (fallback 1)");
    expect(result.cacheable).toBe(false);
    expect(requests).toEqual([
      { model: "jev-1.13", timeout: 15000, retries: 0 },
      { model: "backup-model-1", timeout: 2000, retries: 0 },
    ]);
    expect(events).toEqual([
      {
        event: FALLBACK_EVENT,
        details: {
          requestId: "fallback-test",
          failedEndpoint: 0,
          nextEndpoint: 1,
          modelId: "typesafe/jev-1.13",
          reason: "http-429",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("-key");
    expect(JSON.stringify(events)).not.toContain(".example");
  });

  it("tries subsequent endpoints in order on server and network failure", async () => {
    const { events, log } = recordingLog();
    const engine = createJevEngine({
      config: config(2),
      client: throwingClient(httpError(503)),
      fallbackClients: [throwingClient(new APIConnectionError()), safeClient],
    });
    const result = await engine.review(reviewContext(log));
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toContain("fallback 2");
    expect(events.map((e) => e.details?.reason)).toEqual(["http-503", "connection"]);
  });

  it("does not seek a second opinion on a valid danger verdict or uncertainty", async () => {
    let calls = 0;
    const backup: TypesafeClientLike = {
      systemOne: async () => {
        calls++;
        return response();
      },
    };
    for (const primary of [
      response({
        danger_category: { type: "choice", choice: "secrets_credentials", confidence: 0.9 },
      }),
      response({ risk: { type: "score", score: 0.4, confidence: 0.1 } }),
    ]) {
      const engine = createJevEngine({
        config: config(),
        client: { systemOne: async () => primary },
        fallbackClients: [backup],
      });
      const result = await engine.review(reviewContext(recordingLog().log));
      expect(isMachineryFailure(result)).toBe(false);
      if (isMachineryFailure(result)) return;
      expect(["deny", "defer"]).toContain(result.outcome.verdict.kind);
    }
    expect(calls).toBe(0);
  });

  it("does not resend malformed requests or unexpected local exceptions", async () => {
    let calls = 0;
    const backup: TypesafeClientLike = {
      systemOne: async () => {
        calls++;
        return response();
      },
    };
    for (const error of [
      httpError(400),
      httpError(401),
      httpError(403),
      httpError(404),
      httpError(422),
      new Error("unexpected parsing bug"),
    ]) {
      const engine = createJevEngine({
        config: config(),
        client: throwingClient(error),
        fallbackClients: [backup],
      });
      const result = await engine.review(reviewContext(recordingLog().log));
      expect(isMachineryFailure(result)).toBe(false);
      if (isMachineryFailure(result)) return;
      expect(result.outcome.verdict.kind).toBe("defer");
      expect(result.outcome.deferKind).toBe("call-failed");
    }
    expect(calls).toBe(0);
  });

  it("fails safe when every configured endpoint fails", async () => {
    const { events, log } = recordingLog();
    const engine = createJevEngine({
      config: config(),
      client: throwingClient(httpError(402)),
      fallbackClients: [throwingClient(httpError(503))],
    });
    const result = await engine.review(reviewContext(log));
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(result.modelId).toBe("typesafe/backup-model-1 (fallback 1)");
    expect(events.map((e) => e.event)).toEqual([FALLBACK_EVENT, "ai_guard.model_call_error"]);
  });

  it("preserves the SDK retry policy for existing single-endpoint configs", async () => {
    let retry: unknown = "not called";
    const engine = createJevEngine({
      config: config(0),
      client: {
        systemOne: async (_, options) => {
          retry = options?.retry;
          return response();
        },
      },
    });
    await engine.review(reviewContext(recordingLog().log));
    expect(retry).toBeUndefined();
  });
});

describe("fallback config", () => {
  it("defaults to no backups and requires explicit credentials for each backup", () => {
    expect(config(0).fallbacks).toEqual([]);
    const missingKey = {
      provider: { type: "typesafe", baseUrl: "https://backup.example/api" },
      model: "jev-1.13",
    };
    expect(
      configSchema.safeParse({
        provider: connection("primary"),
        model: "jev-1.13",
        fallbacks: [missingKey],
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        provider: connection("primary"),
        model: "jev-1.13",
        fallbacks: [{ ...missingKey, provider: { ...missingKey.provider, apiKey: "key" } }],
      }).success,
    ).toBe(true);
  });

  it("rejects Jev fallbacks in chat-model mode and an unbounded endpoint list", () => {
    expect(
      configSchema.safeParse({
        provider: "anthropic",
        model: "haiku",
        fallbacks: [config().fallbacks[0]!],
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        provider: connection("primary"),
        model: "jev-1.13",
        fallbacks: Array.from({ length: 6 }, (_, i) => ({
          provider: connection(`backup-${i}`),
          model: "jev",
        })),
      }).success,
    ).toBe(false);
  });
});
