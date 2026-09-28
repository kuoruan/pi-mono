/**
 * LLM adapter tests: error → three-state mapping. The orchestrating loop
 * lives in the pool; here each backend response pins its disposition:
 * answered (valid verdict), retryable (availability failure), or
 * terminal (auth refusal).
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";
import type { ModelCallFn } from "#src/model/model-review.ts";
import { availabilityReason } from "#src/model/model-verdict.ts";
import { createLlmAdapter } from "#src/review/engines/llm/adapter.ts";
import type { AttemptSpec, PoolEndpoint } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { makeDetails } from "#test/fixtures.ts";

import { defaultRegistry, fakeModel } from "../../pipeline-helpers.ts";

function reply(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason,
    errorMessage,
    model: "test",
    provider: "test",
    api: "anthropic-messages",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

function recordingLog() {
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const log = {
    review: (event: string, details: Record<string, unknown>) => events.push({ event, details }),
    debug: (event: string, details: Record<string, unknown>) => events.push({ event, details }),
  };
  return { events, log };
}

function attemptContext(log: ReturnType<typeof recordingLog>["log"]) {
  return {
    transcript: { trustedIntent: ["inspect current directory"], toolCalls: [], strippedCount: 0 },
    request: { ask: buildAskContext(makeDetails({ value: "pwd" }), "/project"), target: "pwd" },
    requestId: "llm-adapter-test",
    log,
  };
}

const registry = defaultRegistry({
  find: (provider, model) => ({ ...fakeModel, provider, id: model }) as Model<any>,
});

/**
 * Per-attempt spec for adapter tests: index 0 with the endpoint's own timeout.
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

const endpoint = (model = "primary", timeoutMs = 5000): PoolEndpoint => ({
  lane: "llm",
  provider: "anthropic",
  model,
  timeoutMs,
});

const adapter = (modelCall: ModelCallFn, registryOverride = registry) =>
  createLlmAdapter({
    config: { reasoning: "off", maxTokens: 4096, instructions: null },
    registry: registryOverride,
    modelCall,
  });

const httpError = (status: number) => Object.assign(new Error("provider failure"), { status });
const allow = () => reply('{"verdict":"allow"}');

describe("LLM adapter disposition", () => {
  it("answers valid verdicts (allow, deny, defer, malformed) without failover signal", async () => {
    for (const text of [
      '{"verdict":"allow"}',
      '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}',
      '{"verdict":"defer","reason":"need context"}',
      "not JSON",
    ]) {
      const attempt = await adapter(async () => reply(text)).attempt(
        endpoint(),
        attemptContext(recordingLog().log),
        spec(0, false),
      );
      expect(attempt.kind).toBe("answered");
      if (attempt.kind !== "answered") continue;
      expect(attempt.result.modelId).toBe("anthropic/primary");
      expect(attempt.result.cacheable).toBeUndefined();
    }
  });

  it.each([402, 404, 408, 409, 410, 425, 429, 503])(
    "reports retryable on HTTP %i with the audit reason",
    async (status) => {
      const { log } = recordingLog();
      const attempt = await adapter(async () => {
        throw httpError(status);
      }).attempt(endpoint(), attemptContext(log), spec(0, false));
      expect(attempt.kind).toBe("retryable");
      if (attempt.kind !== "retryable") return;
      expect(attempt.reason).toBe(`http-${status}`);
      expect(attempt.modelId).toBe("anthropic/primary");
    },
  );

  // Transport refusals are terminal *verdicts* (defer), hence `answered`:
  // the pool only advances on `retryable`, never second-guesses a defer.
  it.each([400, 401, 403, 422])("answers terminal defer on HTTP %i refusal", async (status) => {
    const attempt = await adapter(async () => {
      throw httpError(status);
    }).attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome).toMatchObject({
      verdict: { kind: "defer" },
      deferKind: "call-failed",
    });
  });

  it("reports retryable model-unresolved when the registry entry vanishes", async () => {
    const missing = defaultRegistry({ find: () => undefined });
    const attempt = await adapter(async () => allow(), missing).attempt(
      endpoint(),
      attemptContext(recordingLog().log),
      spec(0, false),
    );
    expect(attempt.kind).toBe("retryable");
    if (attempt.kind !== "retryable") return;
    expect(attempt.reason).toBe("model-unresolved");
    const terminal = attempt.finalize();
    expect(terminal).toMatchObject({ ok: false, kind: "model-unresolved" });
  });

  it("reports terminal machinery on registry auth failure", async () => {
    const denied = defaultRegistry({
      getApiKeyAndHeaders: async () => ({ ok: false, error: "access denied" }),
    });
    const attempt = await adapter(async () => allow(), denied).attempt(
      endpoint(),
      attemptContext(recordingLog().log),
      spec(0, false),
    );
    expect(attempt.kind).toBe("terminal");
    if (attempt.kind !== "terminal") return;
    expect(attempt.result).toMatchObject({ ok: false, kind: "auth-failed" });
  });

  it("passes singleEndpoint through to provider retries", async () => {
    const retries: Array<number | undefined> = [];
    const modelCall: ModelCallFn = async (_, __, options) => {
      retries.push(options?.maxRetries);
      return allow();
    };
    const a = adapter(modelCall);
    await a.attempt(endpoint(), attemptContext(recordingLog().log), spec(0, true));
    await a.attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(retries).toEqual([1, 0]);
  });

  it("never trusts partial allow text from an errored stream", async () => {
    const attempt = await adapter(async () =>
      reply('{"verdict":"allow"}', "error", "403: content blocked"),
    ).attempt(endpoint(), attemptContext(recordingLog().log), spec(0, false));
    expect(attempt.kind).toBe("answered");
    if (attempt.kind !== "answered") return;
    expect(attempt.result.outcome.verdict.kind).toBe("defer");
  });
});

describe("LLM availability and config", () => {
  it("status outranks error text, protecting refusals that mention rate limits", () => {
    expect(
      availabilityReason(
        Object.assign(new Error("quota exceeded; request timeout"), { status: 403 }),
      ),
    ).toBeUndefined();
    expect(availabilityReason("401: FreeUsageLimitError")).toBeUndefined();
    expect(availabilityReason("403: 429 retry later")).toBeUndefined();
    expect(
      availabilityReason("Error: 403 forbidden; FreeUsageLimitError for another account"),
    ).toBeUndefined();
    expect(availabilityReason("access denied: quota exceeded on another account")).toBeUndefined();
    expect(availabilityReason(new Error("unexpected parser bug"))).toBeUndefined();
    expect(availabilityReason("Request failed with status code 429")).toBe("http-429");
    expect(availabilityReason("upstream returned 503")).toBe("http-503");
    expect(
      availabilityReason(Object.assign(new Error("gone"), { response: { status: 404 } })),
    ).toBe("http-404");
    expect(availabilityReason(Object.assign(new Error("conflict"), { status: 409 }))).toBe(
      "http-409",
    );
  });

  it("never lets a nested status override a top-level refusal", () => {
    expect(
      availabilityReason(Object.assign(new Error("denied"), { status: 403, statusCode: 503 })),
    ).toBeUndefined();
    expect(
      availabilityReason(
        Object.assign(new Error("denied"), { status: 403, response: { status: 503 } }),
      ),
    ).toBeUndefined();
  });

  it("switches on quota text without a numeric status", () => {
    expect(availabilityReason("FreeUsageLimitError: free quota exhausted")).toBe("quota");
    expect(availabilityReason(new Error("insufficient_quota for this key"))).toBe("quota");
  });

  it("treats a non-numeric status field as fail-closed", () => {
    expect(
      availabilityReason(
        Object.assign(new Error("weird"), { status: "429", message: "upstream returned 503" }),
      ),
    ).toBeUndefined();
  });

  it("accepts either-lane backups per item and still bounds the list", () => {
    const jevBackup = {
      provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
      model: "jev",
    };
    const parsed = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      fallbacks: [{ provider: "openai", model: "m" }, jevBackup],
    });
    expect(parsed.fallbacks).toHaveLength(2);
    for (const invalid of [
      { provider: "openai", model: "m", apiKey: "secret" },
      { provider: "openai", model: "" },
    ]) {
      expect(
        configSchema.safeParse({ provider: "anthropic", model: "primary", fallbacks: [invalid] })
          .success,
      ).toBe(false);
    }
    expect(
      configSchema.safeParse({
        provider: "anthropic",
        model: "primary",
        fallbacks: Array.from({ length: 6 }, () => ({ provider: "openai", model: "backup" })),
      }).success,
    ).toBe(false);
  });
});
