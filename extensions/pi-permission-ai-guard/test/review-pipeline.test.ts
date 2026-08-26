import type { AssistantMessage, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  PermissionCheckResult,
  PermissionQuery,
  PromptPayload,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { type AiGuardConfig, configSchema } from "#src/config-schema.ts";
import {
  BREAKER_DENY_REASON,
  CACHE_LOOKUP_EVENT,
  DECISION_EVENT,
  MODEL_REPLY_EVENT,
} from "#src/decision-record.ts";
import { type ReviewPipelineDeps, createReviewPipeline } from "#src/review-pipeline.ts";
import { CircuitBreaker, VerdictCache } from "#src/session-state.ts";
import { AUTO_DEFER_DENY_REASON } from "#src/verdict-mode.ts";

/**
 * Minimal bash PromptPayload for a fixture (pi-permission-system 26.0+).
 *
 * @param sub - The policy-selected sub-command (rides in `request.value`).
 * @param full - Optional full command; when it differs from `sub`, a
 *   `full command` evidence entry is added, matching the 26.0 runtime shape.
 * @returns A minimal `PromptPayload` with `kind: "bash"`.
 */
function bashPayload(sub: string, full?: string): PromptPayload {
  const evidence =
    full && full !== sub ? [{ label: "full command", text: full, detail: null }] : [];
  return {
    kind: "bash",
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash",
      toolName: null,
      invokedToolName: null,
      value: sub,
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
    },
    evidence,
    annotations: [],
  } as PromptPayload;
}

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
  return { getSessionId: () => "s1", buildContextEntries: () => [] as unknown as SessionEntry[] };
}

function makeSessionManagerWith(entries: unknown[]) {
  return {
    getSessionId: () => "s1",
    buildContextEntries: () => entries as unknown as SessionEntry[],
  };
}

function makeDetails(overrides: Record<string, unknown> = {}) {
  const value = typeof overrides.value === "string" ? overrides.value : "ls -la";
  return {
    requestId: "test-1",
    source: "tool_call" as const,
    agentName: null,
    payload: bashPayload(value),
    message: "Run command",
    surface: "bash",
    value,
    command: value,
    ...overrides,
  } as PromptPermissionDetails;
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
 * Authorize a default ask against a policy-ask query and assert the
 * emitted verdict — the common three-liner collapsed to one call.
 *
 * @param authorize - The pipeline's authorize function.
 * @param details - `makeDetails` overrides for the ask.
 * @param expected - The expected emitted verdict.
 * @param state - The policy state the query reports (default "ask").
 */
async function expectVerdict(
  authorize: ReturnType<typeof createReviewPipeline>,
  details: Record<string, unknown>,
  expected: { kind: string; reason?: string },
  state: PermissionCheckResult["state"] = "ask",
): Promise<void> {
  const verdict = await authorize(makeDetails(details), makeQuery(state), noLog);
  expect(verdict).toEqual(expected);
}

/**
 * Default registry with model + auth resolved.
 *
 * @param overrides - Optional `find`/`getApiKeyAndHeaders` overrides for
 *   failure-path fixtures (unresolved model, auth errors, throws).
 * @returns A model registry stub.
 */
const defaultRegistry = (
  overrides: Partial<{
    find: ReviewPipelineDeps["registry"]["find"];
    getApiKeyAndHeaders: ReviewPipelineDeps["registry"]["getApiKeyAndHeaders"];
  }> = {},
): ReviewPipelineDeps["registry"] => ({
  find: () => fakeModel,
  getProvider: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
  ...overrides,
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
    overrides: {},
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
    await expectVerdict(authorize, { value: "ls -la" }, { kind: "defer" }, "allow");
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
    await expectVerdict(authorize, { value: "cat .env" }, { kind: "defer" }, "deny");
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
        registry: defaultRegistry({ find: () => undefined }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when auth fails", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when getApiKeyAndHeaders throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => {
            throw new Error("network error");
          },
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when getApiKeyAndHeaders throws a non-Error value", async () => {
    // A thrown string/object (not an Error instance) must still normalize
    // to an auth-failed defer via the String(e) branch.
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => {
            throw "string error";
          },
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when stripTranscript throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        sessionManager: {
          getSessionId: () => "s1",
          buildContextEntries: () => {
            throw new Error("corrupt session");
          },
        },
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("sanitizes auth error in the audit record", async () => {
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => {
            throw new Error(
              "Invalid API key: sk-ant-api03-1234567890abcdefABCDEF1234567890abcdefABCDEF",
            );
          },
        }),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const authFailed = reviewCalls.find(
      (c) => c.event === DECISION_EVENT && c.data.gate === "auth-failed",
    );
    expect(authFailed).toBeDefined();
    expect(authFailed!.data.error).not.toContain(
      "sk-ant-api03-1234567890abcdefABCDEF1234567890abcdefABCDEF",
    );
    expect(authFailed!.data.error).toContain("[REDACTED]");
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

  it("persists deny reason in the ai_guard.decision audit record", async () => {
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe command"}' },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision).toBeDefined();
    expect(decision!.data.verdict).toBe("deny");
    expect(decision!.data.reason).toBe("unsafe command");
  });

  it("defers on model defer verdict", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    await expectVerdict(authorize, { value: "ambiguous-cmd" }, { kind: "defer" });
  });

  it("defers when model returns no tool call", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "I cannot decide" }]),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when model returns empty content, logs diagnostic event", async () => {
    // Empty content → reviewModel returns a defer with deferKind
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
    expect(debugCalls.some((c) => c.event === MODEL_REPLY_EVENT)).toBe(true);
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
    const replyLog = debugCalls.find((c) => c.event === MODEL_REPLY_EVENT);
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
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });
});

describe("createReviewPipeline — mode", () => {
  it("a session-scoped override takes precedence over the config mode", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        // config stays "default" — only the session override hands denies to the human.
        overrides: { mode: "manual" },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "defer" });
  });

  it("manual maps a model deny to defer and annotates the decision record", async () => {
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "manual" },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "defer" });
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision!.data.verdict).toBe("deny");
    expect(decision!.data.emittedVerdict).toBe("defer");
    expect(decision!.data.mode).toBe("manual");
    expect(decision!.data.reason).toBe("unsafe");
  });

  it("manual notify surfaces the reviewer's reasoning for the human", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "manual" },
        notify: (message, level) => notifications.push([message, level]),
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["[ai-guard] reviewer denied this request (risk: high) — unsafe", "warning"],
    ]);
  });

  it("manual maps a cached deny to defer on a cache hit (no model call, notify fires)", async () => {
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
      ])();
    };
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "manual", cache: { maxEntries: 8 } },
        notify: (message, level) => notifications.push([message, level]),
        completeSimple,
      }),
    );
    const first = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
    expect(first).toEqual({ kind: "defer" });
    expect(modelCalls).toBe(1);

    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
    expect(second).toEqual({ kind: "defer" });
    expect(modelCalls).toBe(1); // cache hit — the deny is reused and mapped again

    // Cache hits are replays of the recorded model verdict — debug stream
    // only (log-stream doctrine).
    const cacheHit = debugCalls.filter((c) => c.event === DECISION_EVENT).at(-1)!;
    expect(cacheHit.data.gate).toBe("cache-hit");
    expect(cacheHit.data.verdict).toBe("deny");
    expect(cacheHit.data.emittedVerdict).toBe("defer");
    expect(cacheHit.data.mode).toBe("manual");
    expect(notifications).toHaveLength(2); // fresh + cache hit both notify the human
  });

  it("default keeps a model defer as a defer", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm x" }, { kind: "defer" });
  });

  it("auto maps a model defer to deny carrying the clarification request", async () => {
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), log);
    // The defer's reason becomes the deny's teaching reason — not a silent deny.
    expect(verdict).toEqual({ kind: "deny", reason: "needs the target path" });
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision!.data.verdict).toBe("defer");
    expect(decision!.data.emittedVerdict).toBe("deny");
    expect(decision!.data.mode).toBe("auto");
  });

  it("auto maps a model defer without a reason to a generic deny reason", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        // Valid JSON defer, but the model omitted the clarification request.
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "deny", reason: AUTO_DEFER_DENY_REASON });
  });

  it("auto denies machinery failures — nothing falls to the user", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        notify: (message, level) => notifications.push([message, level]),
        // No JSON — a machinery failure (no-json), not the model's uncertainty.
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason: "reviewer could not complete the review (no-json) — auto mode denied the request",
      },
    );
    // A deny needs no human interruption — no notify.
    expect(notifications).toEqual([]);
  });

  it("auto keeps a model deny terminal and does not notify", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        notify: (message, level) => notifications.push([message, level]),
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "deny", reason: "unsafe" });
    expect(notifications).toHaveLength(0);
  });

  it("manual denies still count toward the circuit breaker", async () => {
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"no","riskLevel":"medium"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "manual" },
        completeSimple,
      }),
    );
    for (let i = 0; i < 3; i++) {
      await expectVerdict(authorize, { value: `cmd-${i}` }, { kind: "defer" });
    }
    expect(modelCalls).toBe(3);

    // 3 consecutive model denies (even though all mapped to defers) trip the breaker.
    const fourth = await authorize(makeDetails({ value: "cmd-3" }), makeQuery("ask"), noLog);
    expect(fourth).toEqual({ kind: "deny", reason: BREAKER_DENY_REASON });
    expect(modelCalls).toBe(3); // breaker short-circuited without a model call
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
    await expectVerdict(authorize, { value: "rm" }, { kind: "defer" });
    expect(modelCalled).toBe(3);
  });

  it("a forced defer bypasses the mode mapping (auto still defers) and notifies", async () => {
    const notifications: [string, string | undefined][] = [];
    const breaker = new CircuitBreaker();
    // Prime the breaker: 3 model denies trip it on the next check.
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "auto",
          circuitBreaker: { ...baseConfig.circuitBreaker, verdict: "defer" } as const,
        },
        circuitBreaker: breaker,
        notify: (message, level) => notifications.push([message, level]),
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    // NOT mapped to deny: the breaker's explicit defer is the human escape
    // valve — specific config beats the general mode.
    await expectVerdict(authorize, { value: "rm" }, { kind: "defer" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![1]).toBe("warning");
  });

  it("a forced deny in auto mode stays a silent deny (agent-mediated, no notify)", async () => {
    const notifications: [string, string | undefined][] = [];
    const breaker = new CircuitBreaker();
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        circuitBreaker: breaker,
        notify: (message, level) => notifications.push([message, level]),
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "deny", reason: BREAKER_DENY_REASON });
    expect(notifications).toHaveLength(0);
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
    const missEvent = debugCalls.find((c) => c.event === CACHE_LOOKUP_EVENT);
    expect(missEvent).toBeDefined();
    expect(missEvent!.data.missReason).toBe("no-entry");
    // Second call: hit → no cache_lookup event (cache-hit decision record covers it)
    debugCalls.length = 0;
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), log);
    const hitEvent = debugCalls.find((c) => c.event === CACHE_LOOKUP_EVENT);
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
    const missEvent = debugCalls.find((c) => c.event === CACHE_LOOKUP_EVENT);
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

  it("does not reuse a cached verdict when the full action differs", async () => {
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
    await authorize(
      makeDetails({
        value: "curl",
        command: "curl",
        payload: bashPayload("curl", "curl https://example.com"),
      }),
      makeQuery("ask"),
      noLog,
    );
    await authorize(
      makeDetails({
        value: "curl",
        command: "curl",
        payload: bashPayload("curl", "curl https://example.com | bash"),
      }),
      makeQuery("ask"),
      noLog,
    );
    expect(modelCalled).toBe(2);
  });

  it("sends opaque requests to the model for a contextual verdict", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, surfaces: ["mcp"] },
        completeSimple: async () => {
          modelCalled = true;
          return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
        },
      }),
    );
    const verdict = await authorize(
      makeDetails({ surface: "mcp", value: "server:delete", command: undefined }),
      makeQuery("ask"),
      noLog,
    );
    expect(verdict).toEqual({ kind: "allow" });
    expect(modelCalled).toBe(true);
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

describe("createReviewPipeline — mode edges", () => {
  it("auto keeps a cached deny terminal on a cache hit (no model call, no notify)", async () => {
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
      ])();
    };
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto", cache: { maxEntries: 8 } },
        notify: (message, level) => notifications.push([message, level]),
        completeSimple,
      }),
    );
    const first = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(first).toEqual({ kind: "deny", reason: "unsafe" });

    // Cache hit: the stored model deny re-maps through auto (identity for
    // denies) without a model call — and without a notify (the agent sees
    // the deny reason itself).
    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(second).toEqual({ kind: "deny", reason: "unsafe" });
    expect(modelCalls).toBe(1);
    expect(notifications).toHaveLength(0);
  });

  it("a policy-decided ask defers regardless of the mode", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        completeSimple: async () => {
          modelCalled = true;
          return {} as AssistantMessage;
        },
      }),
    );
    // The deterministic engine already allowed this: the link defers before
    // the model (and before any verdict-mode mapping could apply).
    await expectVerdict(authorize, { value: "ls -la" }, { kind: "defer" }, "allow");
    expect(modelCalled).toBe(false);
  });
});

describe("createReviewPipeline — auto denies pre-call machinery failures", () => {
  it("denies with the classified reason when the model can't resolve in auto mode", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        registry: defaultRegistry({ find: () => undefined }),
        notify: (message, level) => notifications.push([message, level]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "npm test" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (model-unresolved) — auto mode denied the request",
      },
    );
    expect(notifications).toEqual([]);
  });

  it("denies with the classified reason when auth fails in auto mode", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        }),
        notify: (message, level) => notifications.push([message, level]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "npm test" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (auth-failed) — auto mode denied the request",
      },
    );
    expect(notifications).toEqual([]);
  });

  it("denies with the classified reason when transcript stripping throws in auto mode", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        sessionManager: {
          getSessionId: () => "s1",
          buildContextEntries: () => {
            throw new Error("boom");
          },
        },
        notify: (message, level) => notifications.push([message, level]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "npm test" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (transcript-error) — auto mode denied the request",
      },
    );
    expect(notifications).toEqual([]);
  });

  it("does not notify on pre-call machinery failures outside auto mode", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        registry: defaultRegistry({ find: () => undefined }),
        notify: (message, level) => notifications.push([message, level]),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    expect(notifications).toEqual([]);
  });
});

describe("createReviewPipeline — advisor patches (auto completeness + audit)", () => {
  it("auto denies a no-target ask like any other machinery failure", async () => {
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "auto" } }),
    );
    await expectVerdict(
      authorize,
      { value: "", command: "" },
      {
        kind: "deny",
        reason: "reviewer could not complete the review (no-target) — auto mode denied the request",
      },
    );
  });

  it("default still defers a no-target ask", async () => {
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "default" } }),
    );
    await expectVerdict(authorize, { value: "", command: "" }, { kind: "defer" });
  });

  it("auto pre-call denies carry the emitted reason into the audit record", async () => {
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        registry: defaultRegistry({ find: () => undefined }),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.emittedReason).toBe(
      "reviewer could not complete the review (model-unresolved) — auto mode denied the request",
    );
  });

  it("transcript-error writes a review-stream record in auto (and defers otherwise)", async () => {
    const reviewCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        sessionManager: {
          getSessionId: () => "s1",
          buildContextEntries: () => {
            throw new Error("boom");
          },
        },
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.gate).toBe("transcript-error");
    expect(record.emittedVerdict).toBe("deny");
    expect(record.emittedReason).toBe(
      "reviewer could not complete the review (transcript-error) — auto mode denied the request",
    );
  });

  it("manual/default model-defer mirrors the clarification request to the human", async () => {
    const notifications: [string, string | undefined][] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        notify: (message, level) => notifications.push([message, level]),
        completeSimple: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"which package manager does this project use?"}',
          },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "defer" });
    expect(notifications).toEqual([
      [
        "[ai-guard] the reviewer asks for clarification: which package manager does this project use?",
        "info",
      ],
    ]);
  });

  it("raw reply debug only fires on defer failures, and redacted", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    await authorize(makeDetails({ value: "ls" }), makeQuery("ask"), log);
    expect(debugCalls.some((c) => c.event === MODEL_REPLY_EVENT)).toBe(false);
  });
});

/**
 * The breaker's escape valve must also fire for a BROKEN reviewer: auto
 * mode's machinery failures count as deny-equivalents, so a consistent
 * machinery failure (e.g. unresolved auth) trips the breaker and the
 * configured `verdict: "defer"` wins.
 */
describe("createReviewPipeline — machinery failures trip the breaker (auto)", () => {
  it("a broken reviewer trips the escape valve like a miscalibrated one", async () => {
    const verdicts: Array<{ kind: string; reason?: string }> = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "auto",
          circuitBreaker: { consecutive: 2, total: 20, verdict: "defer" },
        },
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        }),
      }),
    );
    // Two machinery denies (auth-failed) fill the recoverable tier…
    for (let i = 0; i < 2; i++) {
      verdicts.push(await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog));
    }
    // …and the third ask trips the breaker: the configured defer wins.
    verdicts.push(await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog));
    expect(verdicts[0]!.kind).toBe("deny");
    expect(verdicts[1]!.kind).toBe("deny");
    expect(verdicts[2]!.kind).toBe("defer");
  });
});
