import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import { configSchema, hasTypesafeProvider } from "#src/config/config-schema.ts";
import type { ModelCallFn } from "#src/model/model-review.ts";
import { availabilityReason } from "#src/review/engines/llm/availability.ts";
import { createLlmEngine } from "#src/review/engines/llm/engine.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";
import { makeDetails } from "#test/fixtures.ts";

import { defaultRegistry, fakeModel } from "../../pipeline-helpers.ts";

function config(
  fallbacks: Array<{ provider: string; model: string; timeoutMs?: number }> = [
    { provider: "openai", model: "backup", timeoutMs: 2500 },
  ],
) {
  const parsed = configSchema.parse({ provider: "anthropic", model: "primary", fallbacks });
  if (hasTypesafeProvider(parsed)) throw new Error("expected chat-model config");
  return parsed;
}

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
    debug: () => {},
  };
  return { events, log };
}

function reviewContext(log: ReturnType<typeof recordingLog>["log"]) {
  return {
    transcript: { trustedIntent: ["inspect current directory"], toolCalls: [], strippedCount: 0 },
    request: { ask: buildAskContext(makeDetails({ value: "pwd" }), "/project"), target: "pwd" },
    requestId: "llm-fallback-test",
    log,
  };
}

const registry = defaultRegistry({
  find: (provider, model) => ({ ...fakeModel, provider, id: model }) as Model<any>,
});

function engine(modelCall: ModelCallFn, fallbacks?: ReturnType<typeof config>["fallbacks"]) {
  return createLlmEngine({ config: config(fallbacks), registry, modelCall });
}

const httpError = (status: number) => Object.assign(new Error("provider failure"), { status });

const allow = () => reply('{"verdict":"allow"}');

describe("LLM fallback", () => {
  it("keeps a healthy primary's decision and does not call backups", async () => {
    const { events, log } = recordingLog();
    const calls: Array<{ id: string; retries: number | undefined }> = [];
    const modelCall: ModelCallFn = async (model, _, options) => {
      calls.push({ id: model.id, retries: options?.maxRetries });
      return allow();
    };
    const result = await engine(modelCall).review(reviewContext(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("anthropic/primary");
    expect(result.cacheable).toBeUndefined();
    expect(calls).toEqual([{ id: "primary", retries: 0 }]);
    expect(events).toEqual([]);
  });

  it("retains legacy provider retry when no backup is configured", async () => {
    const retries: Array<number | undefined> = [];
    const modelCall: ModelCallFn = async (_, __, options) => {
      retries.push(options?.maxRetries);
      return allow();
    };
    await engine(modelCall, []).review(reviewContext(recordingLog().log));
    expect(retries).toEqual([1]);
  });

  it.each([402, 404, 410, 429, 503])(
    "switches to another model on HTTP %i without caching its verdict",
    async (status) => {
      const { events, log } = recordingLog();
      const calls: string[] = [];
      const modelCall: ModelCallFn = async (model, _, options) => {
        calls.push(model.id);
        expect(options?.maxRetries).toBe(0);
        if (model.id === "primary") throw httpError(status);
        return allow();
      };
      const result = await engine(modelCall).review(reviewContext(log));
      if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
      expect(result.outcome.verdict.kind).toBe("allow");
      expect(result.modelId).toBe("openai/backup (fallback 1)");
      expect(result.cacheable).toBe(false);
      expect(calls).toEqual(["primary", "backup"]);
      expect(events).toEqual([
        {
          event: FALLBACK_EVENT,
          details: {
            requestId: "llm-fallback-test",
            failedEndpoint: 0,
            nextEndpoint: 1,
            modelId: "anthropic/primary",
            reason: `http-${status}`,
          },
        },
      ]);
    },
  );

  it.each([
    ["timeout", new DOMException("review timeout", "TimeoutError")],
    ["connection", Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })],
  ])("switches after a %s failure", async (reason, failure) => {
    const calls: string[] = [];
    const { events, log } = recordingLog();
    const result = await engine(async (model) => {
      calls.push(model.id);
      if (model.id === "primary") throw failure;
      return allow();
    }).review(reviewContext(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(calls).toEqual(["primary", "backup"]);
    expect(events[0]?.details.reason).toBe(reason);
  });

  it("switches when the free model vanishes from the registry", async () => {
    const { events, log } = recordingLog();
    const calls: string[] = [];
    const missingPrimary = defaultRegistry({
      find: (provider, model) =>
        model === "primary" ? undefined : ({ ...fakeModel, provider, id: model } as Model<any>),
    });
    const result = await createLlmEngine({
      config: config(),
      registry: missingPrimary,
      modelCall: async (model) => {
        calls.push(model.id);
        return allow();
      },
    }).review(reviewContext(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(calls).toEqual(["backup"]);
    expect(result.cacheable).toBe(false);
    expect(events[0]?.details.reason).toBe("model-unresolved");
  });

  it("recognizes a quota error returned as a reply, without retrying a refusal", async () => {
    const calls: string[] = [];
    const { events, log } = recordingLog();
    const result = await engine(async (model) => {
      calls.push(model.id);
      return model.id === "primary"
        ? reply("", "error", "429: FreeUsageLimitError: quota exhausted")
        : allow();
    }).review(reviewContext(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(calls).toEqual(["primary", "backup"]);
    expect(events[0]?.details.reason).toBe("http-429");
  });

  it("does not bypass a provider refusal even if its error mentions quota", async () => {
    const calls: string[] = [];
    const result = await engine(async (model) => {
      calls.push(model.id);
      return reply("", "error", "403: policy blocked; quota exceeded on another account");
    }).review(reviewContext(recordingLog().log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(calls).toEqual(["primary"]);
  });

  it("switches on quota exhaustion without a numeric status", async () => {
    const calls: string[] = [];
    const result = await engine(async (model) => {
      calls.push(model.id);
      return model.id === "primary" ? reply("", "error", "FreeUsageLimitError") : allow();
    }).review(reviewContext(recordingLog().log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(calls).toEqual(["primary", "backup"]);
  });

  it("does not seek a second opinion on a real deny, model defer, or malformed reply", async () => {
    const responses = [
      reply('{"verdict":"deny","reason":"unsafe","riskLevel":"high"}'),
      reply('{"verdict":"defer","reason":"need context"}'),
      reply("not JSON"),
    ];
    for (const primary of responses) {
      let calls = 0;
      const result = await engine(async () => {
        calls++;
        return primary;
      }).review(reviewContext(recordingLog().log));
      if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
      expect(result.modelId).toBe("anthropic/primary");
      expect(calls).toBe(1);
    }
  });

  it.each([400, 401, 403, 422])("does not bypass an HTTP %i refusal", async (status) => {
    let calls = 0;
    const result = await engine(async () => {
      calls++;
      throw httpError(status);
    }).review(reviewContext(recordingLog().log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(calls).toBe(1);
  });

  it("does not bypass a registry auth failure", async () => {
    let calls = 0;
    const deniedAuth = defaultRegistry({
      getApiKeyAndHeaders: async () => ({ ok: false, error: "access denied" }),
    });
    const result = await createLlmEngine({
      config: config(),
      registry: deniedAuth,
      modelCall: async () => {
        calls++;
        return allow();
      },
    }).review(reviewContext(recordingLog().log));
    expect(isMachineryFailure(result)).toBe(true);
    expect(calls).toBe(0);
  });

  it.each(["error", "aborted"] as const)(
    "never trusts partial allow text from an %s during an empty-reply retry",
    async (stopReason) => {
      const calls: string[] = [];
      const result = await engine(async (model) => {
        calls.push(model.id);
        if (calls.length === 1) return reply("");
        if (model.id === "primary")
          return reply('{"verdict":"allow"}', stopReason, "429: unavailable");
        return reply('{"verdict":"deny","reason":"unsafe","riskLevel":"high"}');
      }).review(reviewContext(recordingLog().log));
      if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
      expect(result.outcome.verdict.kind).toBe("deny");
      expect(calls).toEqual(["primary", "primary", "backup"]);
    },
  );

  it("stops when a backup lacks auth rather than skipping to a third model", async () => {
    const calls: string[] = [];
    const { events, log } = recordingLog();
    const missingBackupAuth = defaultRegistry({
      find: (provider, model) => ({ ...fakeModel, provider, id: model }) as Model<any>,
      getApiKeyAndHeaders: async (model) =>
        model.id === "backup"
          ? { ok: false, error: "missing credentials" }
          : { ok: true, apiKey: "k" },
    });
    const result = await createLlmEngine({
      config: config([
        { provider: "openai", model: "backup" },
        { provider: "google", model: "third" },
      ]),
      registry: missingBackupAuth,
      modelCall: async (model) => {
        calls.push(model.id);
        if (model.id === "primary") throw httpError(429);
        return allow();
      },
    }).review(reviewContext(log));
    expect(isMachineryFailure(result)).toBe(true);
    expect(result.modelId).toBe("openai/backup (fallback 1)");
    expect(calls).toEqual(["primary"]);
    expect(events.map((e) => e.details.reason)).toEqual(["http-429"]);
  });

  it("preserves a failed provider's verdict even if its error reply includes JSON text", async () => {
    const calls: string[] = [];
    const result = await engine(async (model) => {
      calls.push(model.id);
      return model.id === "primary"
        ? reply('{"verdict":"allow"}', "error", "403: content blocked")
        : allow();
    }).review(reviewContext(recordingLog().log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(calls).toEqual(["primary"]);
  });

  it("tries backups in order and fails safe if every service is unavailable", async () => {
    const { events, log } = recordingLog();
    const result = await engine(
      async (model) => {
        if (model.id === "primary") throw httpError(429);
        if (model.id === "backup") throw httpError(503);
        throw httpError(503);
      },
      [
        { provider: "openai", model: "backup", timeoutMs: 2000 },
        { provider: "google", model: "third", timeoutMs: 3000 },
      ],
    ).review(reviewContext(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery failure");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(result.modelId).toBe("google/third (fallback 2)");
    expect(events.map((e) => e.details.reason)).toEqual(["http-429", "http-503"]);
    expect(JSON.stringify(events)).not.toContain("provider failure");
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

  it("accepts chat-model backups but rejects cross-lane entries and unknown fields", () => {
    expect(config().fallbacks).toHaveLength(1);
    expect(config([]).fallbacks).toEqual([]);
    for (const invalid of [
      { provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" }, model: "jev" },
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
        provider: { type: "typesafe" },
        model: "jev",
        fallbacks: [{ provider: "openai", model: "m" }],
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        provider: "anthropic",
        model: "primary",
        fallbacks: Array.from({ length: 6 }, () => ({ provider: "openai", model: "backup" })),
      }).success,
    ).toBe(false);
  });
});
