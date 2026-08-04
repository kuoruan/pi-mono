import type { AssistantMessage, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PermissionCheckResult, PermissionQuery } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { type AiGuardConfig, configSchema } from "#src/config-schema.ts";
import { type ReviewPipelineDeps, createReviewPipeline } from "#src/review-pipeline.ts";
import { CircuitBreaker, VerdictCache } from "#src/session-state.ts";

const baseConfig: AiGuardConfig = configSchema.parse({
  provider: "anthropic",
  model: "test-model",
  cache: { maxEntries: 0 },
});

function makeFakeCompleteSimple(
  replyContent: AssistantMessage["content"],
): (
  _model?: Model<any>,
  _context?: Context,
  _options?: SimpleStreamOptions,
) => Promise<AssistantMessage> {
  return async (): Promise<AssistantMessage> =>
    ({
      role: "assistant",
      content: replyContent,
      stopReason: "toolUse",
      api: "anthropic-messages",
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        total: 150,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }) as AssistantMessage;
}

function makeEmptySessionManager() {
  return { buildContextEntries: () => [] as unknown as SessionEntry[] };
}

function makeSessionManagerWith(entries: unknown[]) {
  return { buildContextEntries: () => entries as unknown as SessionEntry[] };
}

function makeDetails(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "test-1",
    source: "tool_call" as const,
    agentName: null,
    message: "Run command",
    surface: "bash",
    value: "ls -la",
    ...overrides,
  };
}

/**
 * A PermissionQuery whose checkPermission returns the given state.
 *
 * @param state - The policy state to return.
 * @returns A `PermissionQuery` stub.
 */
function makeQuery(state: PermissionCheckResult["state"]): PermissionQuery {
  const result = { state } as unknown as PermissionCheckResult;
  return {
    checkPermission: () => result,
    getToolPermission: () => state,
  };
}

/**
 * A query whose checkPermission records calls for assertions.
 *
 * @param state - The policy state to return.
 * @returns The query and a `calls` array recording each checkPermission invocation.
 */
function makeRecordingQuery(state: PermissionCheckResult["state"]): {
  query: PermissionQuery;
  calls: { surface: string; value: string | undefined; agentName?: string }[];
} {
  const calls: { surface: string; value: string | undefined; agentName?: string }[] = [];
  const result = { state } as unknown as PermissionCheckResult;
  const query: PermissionQuery = {
    checkPermission: (surface, value, agentName) => {
      calls.push({ surface, value, agentName });
      return result;
    },
    getToolPermission: () => state,
  };
  return { query, calls };
}

const fakeModel = { provider: "test", id: "test-model" } as unknown as Model<any>;

const noLog = { review: () => {}, debug: () => {} } as never;

/**
 * Default registry with model + auth resolved.
 *
 * @returns A model registry stub with resolved model and auth.
 */
const defaultRegistry = (): ReviewPipelineDeps["registry"] => ({
  find: () => fakeModel,
  getProvider: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
});

/**
 * Build a ReviewPipeline from resolved session state. Overrides replace the
 * direct values (not lazy getters) — the pipeline closes over them once.
 *
 * @param overrides - Optional `ReviewPipelineDeps` overrides.
 * @returns The assembled `ReviewPipelineDeps`.
 */
function makePipeline(overrides: Partial<ReviewPipelineDeps> = {}): ReviewPipelineDeps {
  return {
    config: baseConfig,
    registry: defaultRegistry(),
    sessionManager: makeEmptySessionManager(),
    cwd: "/project",
    circuitBreaker: new CircuitBreaker(),
    verdictCache: new VerdictCache(),
    completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
    ...overrides,
  };
}

describe("createReviewPipeline — guard clauses", () => {
  // Surface matching and target extraction are tested directly in
  // ask-eligibility.test.ts (pure function, no model stack needed).

  it("defers without a model call when policy already allows", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: async () => {
          modelCalled = true;
          return {} as AssistantMessage;
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "ls -la" }), makeQuery("allow"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
    expect(modelCalled).toBe(false);
  });

  it("defers without a model call when policy already denies", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: async () => {
          modelCalled = true;
          return {} as AssistantMessage;
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "cat .env" }), makeQuery("deny"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
    expect(modelCalled).toBe(false);
  });

  it("queries the deterministic engine at gate parity", async () => {
    const { query, calls } = makeRecordingQuery("ask");
    const authorize = createReviewPipeline(makePipeline());
    await authorize(makeDetails({ value: "npm test", agentName: "my-agent" }), query, noLog);
    expect(calls).toEqual([{ surface: "bash", value: "npm test", agentName: "my-agent" }]);
  });

  it("defers when model is not found in registry", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: {
          find: () => undefined,
          getProvider: () => undefined,
          getApiKeyAndHeaders: async () => ({ ok: true }),
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when auth fails", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: {
          find: () => fakeModel,
          getProvider: () => undefined,
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when getApiKeyAndHeaders throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: {
          find: () => fakeModel,
          getProvider: () => undefined,
          getApiKeyAndHeaders: async () => {
            throw new Error("network error");
          },
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when getApiKeyAndHeaders throws a non-Error value", async () => {
    // A thrown string/object (not an Error instance) must still normalize
    // to an auth-failed defer via the String(e) branch.
    const authorize = createReviewPipeline(
      makePipeline({
        registry: {
          find: () => fakeModel,
          getProvider: () => undefined,
          getApiKeyAndHeaders: async () => {
            throw "string error";
          },
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when stripTranscript throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        sessionManager: {
          buildContextEntries: () => {
            throw new Error("corrupt session");
          },
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });
});

describe("createReviewPipeline — verdicts", () => {
  it("returns allow when model allows", async () => {
    const authorize = createReviewPipeline(makePipeline());
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("returns deny with reason when model denies", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "deny", reason: "unsafe" });
  });

  it("defers on model defer verdict", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    const verdict = await authorize(
      makeDetails({ value: "ambiguous-cmd" }),
      makeQuery("ask"),
      noLog,
    );
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when model returns no tool call", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "I cannot decide" }]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });

  it("defers when model returns empty content, logs diagnostic event", async () => {
    // Empty content → reviewModel returns a defer with deferReason
    // "empty-reply". A diagnostic event (stopReason/contentTypes) is logged
    // via MODEL_REPLY_EVENT so the operator can investigate the cause.
    const debugCalls: { event: string }[] = [];
    const log = {
      review: () => {},
      debug: (e: string) => debugCalls.push({ event: e }),
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({ completeSimple: makeFakeCompleteSimple([]) }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "defer" });
    // Empty content → diagnostic event is logged via MODEL_REPLY_EVENT
    expect(debugCalls.some((c) => c.event === "ai_guard.model_reply")).toBe(true);
  });

  it("falls back to text parsing when model emits prose", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: 'My verdict: {"verdict": "allow"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("logs the full raw model reply without truncation", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const longText = "x".repeat(600);
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: longText }]),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const replyLog = debugCalls.find((c) => c.event === "ai_guard.model_reply");
    expect(replyLog).toBeDefined();
    const raw = replyLog!.data.rawReply as string;
    expect(raw).toBe(longText);
    expect(raw.length).toBe(600);
  });

  it("defers when model call throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, timeoutMs: 100 },
        completeSimple: async () => {
          throw new Error("network error");
        },
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
  });
});

describe("createReviewPipeline — circuit breaker", () => {
  it("short-circuits to deny after consecutive threshold (default)", async () => {
    let modelCalled = 0;
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    const authorize = createReviewPipeline(
      makePipeline({
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
          ])();
        },
      }),
    );
    // 3 denies → trip on the 4th call (breaker checked before model)
    await authorize(makeDetails({ value: "rm -rf x" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "rm -rf x" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "rm -rf x" }), makeQuery("ask"), noLog);
    const verdict = await authorize(makeDetails({ value: "rm -rf x" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "deny", reason: expect.any(String) });
    expect(modelCalled).toBe(3); // the 4th was short-circuited
  });

  it("short-circuit does not call recordVerdict (no double count)", async () => {
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    let modelCalled = 0;
    const denyAuthorize = createReviewPipeline(
      makePipeline({
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
          ])();
        },
      }),
    );
    // 3 denies → consecutive hits threshold
    for (let i = 0; i < 3; i++)
      await denyAuthorize(makeDetails({ value: "rm" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(3);
    // 4th call: breaker trips (consecutive=3) → short-circuit deny, resets consecutive.
    // The short-circuit does NOT call recordVerdict, so total stays at 3.
    const tripVerdict = await denyAuthorize(makeDetails({ value: "rm" }), makeQuery("ask"), noLog);
    expect(tripVerdict.kind).toBe("deny");
    expect(modelCalled).toBe(3); // no model call on the trip
    // 5th call with an allowing model: consecutive was reset to 0, total=3 < 20
    // → NOT tripped → model called → allow.
    const allowAuthorize = createReviewPipeline(
      makePipeline({
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    const verdict = await allowAuthorize(makeDetails({ value: "ls" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
    expect(modelCalled).toBe(4); // 3 denies + 1 allow
  });

  it("returns defer when circuitBreaker.verdict is defer", async () => {
    let modelCalled = 0;
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          circuitBreaker: { ...baseConfig.circuitBreaker, verdict: "defer" } as const,
        },
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
          ])();
        },
      }),
    );
    for (let i = 0; i < 3; i++)
      await authorize(makeDetails({ value: "rm" }), makeQuery("ask"), noLog);
    const verdict = await authorize(makeDetails({ value: "rm" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "defer" });
    expect(modelCalled).toBe(3);
  });
});

describe("createReviewPipeline — verdict cache", () => {
  it("emits a cache_lookup debug event only on miss (hit is covered by decision record)", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () =>
          makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])(),
      }),
    );
    // First call: miss → cache_lookup event with missReason
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), log);
    const missEvent = debugCalls.find((c) => c.event === "ai_guard.cache_lookup");
    expect(missEvent).toBeDefined();
    expect(missEvent!.data.missReason).toBe("no-entry");
    // Second call: hit → no cache_lookup event (cache-hit decision record covers it)
    debugCalls.length = 0;
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), log);
    const hitEvent = debugCalls.find((c) => c.event === "ai_guard.cache_lookup");
    expect(hitEvent).toBeUndefined();
  });

  it("emits a cache_lookup event with missReason when cache is disabled", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    // cache disabled → always disabled miss
    const authorize = createReviewPipeline(makePipeline());
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), log);
    const missEvent = debugCalls.find((c) => c.event === "ai_guard.cache_lookup");
    expect(missEvent).toBeDefined();
    expect(missEvent!.data.missReason).toBe("disabled");
  });

  it("reuses a cached verdict without calling the model", async () => {
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    let modelCalled = 0;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(1);
    // Same command + same (empty) intent → cache hit
    const v = await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    expect(v).toEqual({ kind: "allow" });
    expect(modelCalled).toBe(1);
  });

  it("does not cache when cache.maxEntries is 0", async () => {
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    let modelCalled = 0;
    const authorize = createReviewPipeline(
      makePipeline({
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(2);
  });

  it("does not cache defer verdicts (model is called again)", async () => {
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    let modelCalled = 0;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          // Always defer — should never be cached.
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }])();
        },
      }),
    );
    // First call: model defers → not cached
    const v1 = await authorize(makeDetails({ value: "ambiguous" }), makeQuery("ask"), noLog);
    expect(v1).toEqual({ kind: "defer" });
    expect(modelCalled).toBe(1);
    // Second call with same command: defer was not cached → model called again
    const v2 = await authorize(makeDetails({ value: "ambiguous" }), makeQuery("ask"), noLog);
    expect(v2).toEqual({ kind: "defer" });
    expect(modelCalled).toBe(2);
  });

  it("misses when trusted intent changes (different contextHash)", async () => {
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    let modelCalled = 0;
    const sm1 = makeSessionManagerWith([
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: { role: "user", content: "first intent" },
      },
    ]);
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        sessionManager: sm1,
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    await authorize(makeDetails({ value: "ls" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(1);
    // Change session manager to a different intent
    const sm2 = makeSessionManagerWith([
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: { role: "user", content: "different intent" },
      },
    ]);
    const authorize2 = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        sessionManager: sm2,
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    await authorize2(makeDetails({ value: "ls" }), makeQuery("ask"), noLog);
    // Different contextHash → miss → model called again
    expect(modelCalled).toBe(2);
  });

  it("does not reuse a cached verdict across different cwds", async () => {
    const breaker = new CircuitBreaker();
    const cache = new VerdictCache();
    let modelCalled = 0;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    // First call in /project → model called, verdict cached for that cwd
    await authorize(makeDetails({ value: "rm -rf build" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(1);
    // Same command, same cwd → cache hit, no model call
    await authorize(makeDetails({ value: "rm -rf build" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(1);
    // Same command but different cwd → must miss (cwd is part of the cache key
    // because the prompt feeds cwd to the model, so `rm -rf build` resolves
    // differently per directory)
    const otherCwdAuthorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        cwd: "/other-project",
        circuitBreaker: breaker,
        verdictCache: cache,
        completeSimple: async () => {
          modelCalled++;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    await otherCwdAuthorize(makeDetails({ value: "rm -rf build" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(2);
  });
});

describe("createReviewPipeline — transcript stripping", () => {
  // Target extraction (matchValues/value/command/path/target/toolName/skillName)
  // is tested directly in ask-eligibility.test.ts as a pure function.

  it("strips transcript from session manager", async () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: { role: "user", content: "fix bug" },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "x",
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "huge content" }],
        },
      },
    ];
    const authorize = createReviewPipeline(
      makePipeline({ sessionManager: makeSessionManagerWith(entries) }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
  });
});
