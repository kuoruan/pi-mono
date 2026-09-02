import type { AssistantMessage, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  PermissionCheckResult,
  PermissionQuery,
  PromptPayload,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import {
  BREAKER_DENY_REASON,
  CACHE_LOOKUP_EVENT,
  DECISION_EVENT,
  MODEL_REPLY_EVENT,
} from "#src/audit/decision-record.ts";
import { type AiGuardConfig, configSchema } from "#src/config/config-schema.ts";
import { CircuitBreaker } from "#src/review/circuit-breaker.ts";
import {
  type NotifyFn,
  type ReviewPipelineDeps,
  createReviewPipeline,
} from "#src/review/review-pipeline.ts";
import { VerdictCache } from "#src/review/verdict-cache.ts";
import { uncertainDenyReason, withAgentInstruction } from "#src/review/verdict-mode.ts";

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

/** A recorded log emission. */
export interface RecordedLog {
  event: string;
  data: Record<string, unknown>;
}

/**
 * A log pair that records every review/debug emission for assertions — the
 * once-per-test collector boilerplate collapsed to one call.
 *
 * @returns The recording log and its collected review/debug emissions.
 */
function makeRecordingLog(): {
  log: {
    review: (event: string, data: Record<string, unknown>) => void;
    debug: (event: string, data: Record<string, unknown>) => void;
  };
  reviewCalls: RecordedLog[];
  debugCalls: RecordedLog[];
} {
  const reviewCalls: RecordedLog[] = [];
  const debugCalls: RecordedLog[] = [];
  const log = {
    review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
    debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
  };
  return { log, reviewCalls, debugCalls };
}

/**
 * A notify spy that records (message, level) pairs — the once-per-test
 * notification boilerplate collapsed to one call.
 *
 * @returns The spy and its collected (message, level) pairs.
 */
function makeNotifySpy(): {
  notifications: [string, string | undefined][];
  notify: NotifyFn;
} {
  const notifications: [string, string | undefined][] = [];
  const notify = (message: string, level?: string) => notifications.push([message, level]);
  return { notifications, notify };
}

/**
 * Authorize a default ask against a policy-ask query and assert the
 * emitted verdict — the common three-liner collapsed to one call.
 *
 * A `deny` expectation asserts the reason as `baseReason — instruction`:
 * terminal denies carry the agent-facing instruction appended by the
 * pipeline (the audit/notify copies keep the bare reason).
 *
 * @param authorize - The pipeline's authorize function.
 * @param details - `makeDetails` overrides for the ask.
 * @param expected - The expected emitted verdict (`reason` on a deny is
 *   the base reason the instruction is appended to).
 * @param state - The policy state the query reports (default "ask").
 * @param denySource - The expected instruction variant for a deny
 *   (default `"content"`; `"machinery"` for reviewer-failure denies).
 */
async function expectVerdict(
  authorize: ReturnType<typeof createReviewPipeline>,
  details: Record<string, unknown>,
  expected: { kind: string; reason?: string },
  state: PermissionCheckResult["state"] = "ask",
  denySource: "content" | "machinery" = "content",
): Promise<void> {
  const verdict = await authorize(makeDetails(details), makeQuery(state), noLog);
  // A deny's expectation is the base reason with the agent instruction
  // appended (terminal denies carry it); anything else asserts as-is.
  const expectedVerdict =
    expected.kind === "deny"
      ? {
          kind: "deny",
          reason: withAgentInstruction(expected.reason, denySource),
        }
      : expected;
  expect(verdict).toEqual(expectedVerdict);
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
    denyHistory: [],
    overrides: {},
    completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
    // Required in production (the lifecycle's notify bridge); tests that
    // don't assert notifications get a no-op.
    notify: () => {},
    ...overrides,
  };
}

describe("createReviewPipeline — guard clauses", () => {
  // Surface matching and target extraction are tested directly in
  // ask.test.ts (pure function, no model stack needed).

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
    const { log, reviewCalls } = makeRecordingLog();
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
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
  });

  it("persists deny reason in the ai_guard.decision audit record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
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
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
        notify,
      }),
    );
    await expectVerdict(authorize, { value: "ambiguous-cmd" }, { kind: "defer" });
    // A terse model defer without a reason is the model's own verdict, not
    // machinery — no cause-notice and no clarification to mirror (H1 pin).
    expect(notifications).toEqual([]);
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

  it("carries the review diagnostic (stopReason/rawStopReason/contentTypes/errorMessage) in the decision record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: async () =>
          ({
            role: "assistant",
            content: [],
            stopReason: "aborted",
            rawStopReason: "max_tokens",
            errorMessage: "provider hiccup",
          }) as unknown as AssistantMessage,
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.findLast((c) => c.event === DECISION_EVENT)!.data;
    expect(record.deferKind).toBe("timeout"); // aborted → timeout, not empty-reply
    expect(record.diagnostic).toEqual({
      stopReason: "aborted",
      rawStopReason: "max_tokens",
      contentTypes: [],
      errorMessage: "provider hiccup",
    });
    expect(typeof record.latencyMs).toBe("number");
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

  it("redacts the raw reply in the always-on review record (defer failures)", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const credential = "sk-ant-api03-0123456789abcdef0123456789abcdef0123456789";
    const authorize = createReviewPipeline(
      makePipeline({
        // No JSON — a machinery defer whose raw text carries the credential.
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: `the prompt had ${credential} but {not json` },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.findLast((c) => c.event === DECISION_EVENT)!.data;
    const raw = record.rawReply as string;
    // The review stream is always on — never carry raw model text there.
    expect(raw).not.toContain(credential);
    // …but the redacted text must still BE there (kept-but-redacted, not
    // dropped entirely — the defer-failure raw reply is the replay material).
    expect(raw).toBeTruthy();
  });
});

describe("createReviewPipeline — mode", () => {
  it("a session-scoped override takes precedence over the config mode", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        // config stays "default" — only the session override hands denies to the human.
        overrides: { mode: "lenient" },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "defer" });
  });

  it("default maps a soft deny to defer and annotates the decision record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "defer" });
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision!.data.verdict).toBe("deny");
    expect(decision!.data.emittedVerdict).toBe("defer");
    expect(decision!.data.mode).toBe("default");
    expect(decision!.data.reason).toBe("unsafe");
  });

  it("default maps a cached deny to defer on a cache hit (no model call, notify fires)", async () => {
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
      ])();
    };
    const { log, reviewCalls, debugCalls } = makeRecordingLog();
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { maxEntries: 8 } },
        notify,
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
    expect(cacheHit.data.mode).toBe("default");
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

  it("strict maps a model defer to deny carrying the clarification request", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), log);
    // The defer's reason becomes the deny's teaching reason — not a silent deny.
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction("needs the target path", "content"),
    });
    // The deny is mode-mapped (a synthesized teaching reason), not the
    // model's own deny — deny notifies cover only model denies, so this
    // stays silent (the ask did not hold or escalate; nothing reached
    // the human).
    expect(notifications).toEqual([]);
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision!.data.verdict).toBe("defer");
    expect(decision!.data.emittedVerdict).toBe("deny");
    // The agent received the synthesized teaching reason — never a
    // "clarification-suppressed" marker on a deny (nothing was swallowed).
    expect(decision!.data.emittedReason).toBe("needs the target path");
    expect(decision!.data.mode).toBe("strict");
  });

  it("strict maps a model defer without a reason to a generic deny reason", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        // Valid JSON defer, but the model omitted the clarification request.
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction(uncertainDenyReason("strict"), "content"),
    });
  });

  it("strict denies machinery failures — nothing falls to the user", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        // No JSON — a machinery failure (no-json), not the model's uncertainty.
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason: "reviewer could not complete the review (no-json) — strict mode denied the request",
      },
      "ask",
      "machinery",
    );
    // A deny needs no human interruption — no notify.
    expect(notifications).toEqual([]);
  });

  it("strict keeps a model deny terminal and notifies (denials have no dialog)", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
    expect(notifications).toEqual([
      ["reviewer denied this request (risk high) — unsafe", "warning"],
    ]);
  });

  it("lenient denies still count toward the circuit breaker", async () => {
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"no","riskLevel":"medium"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        completeSimple,
      }),
    );
    for (let i = 0; i < 3; i++) {
      await expectVerdict(authorize, { value: `cmd-${i}` }, { kind: "defer" });
    }
    expect(modelCalls).toBe(3);

    // 3 consecutive model denies (even though all mapped to defers) trip the breaker.
    const fourth = await authorize(makeDetails({ value: "cmd-3" }), makeQuery("ask"), noLog);
    expect(fourth).toEqual({
      kind: "deny",
      reason: withAgentInstruction(BREAKER_DENY_REASON, "machinery"),
    });
    expect(modelCalls).toBe(3); // breaker short-circuited without a model call
  });
});

describe("createReviewPipeline — circuit breaker", () => {
  it("the total-tier trip notifies the operator once per epoch", async () => {
    const { notifications, notify } = makeNotifySpy();
    const breaker = new CircuitBreaker();
    const authorize = createReviewPipeline(
      makePipeline({
        circuitBreaker: breaker,
        verdictCache: new VerdictCache(),
        notify,
        config: { ...baseConfig, circuitBreaker: { consecutive: 3, total: 3, verdict: "deny" } },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
        ]),
      }),
    );
    // 3 denies reach the total threshold — the 4th and 5th asks trip on
    // the total tier; the notice fires on the 4th only.
    for (let i = 0; i < 3; i++)
      await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    const tripNotices = notifications.filter(([m]) => m.includes("total tier reached"));
    expect(tripNotices).toHaveLength(1);
    expect(tripNotices[0]![1]).toBe("error");
    expect(tripNotices[0]![0]).toContain("breaker reset");
    // A manual reset re-arms the epoch notice (3 more denies → next trip
    // notifies again).
    breaker.resetAll({ consecutive: 3, total: 3, verdict: "deny" });
    for (let i = 0; i < 3; i++)
      await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    expect(notifications.filter(([m]) => m.includes("total tier reached"))).toHaveLength(2);
  });

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
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction(BREAKER_DENY_REASON, "machinery"),
    });
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

  it("a forced defer bypasses the mode mapping (strict still defers) and notifies", async () => {
    const { notifications, notify } = makeNotifySpy();
    const breaker = new CircuitBreaker();
    // Prime the breaker: 3 model denies trip it on the next check.
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "strict",
          circuitBreaker: { ...baseConfig.circuitBreaker, verdict: "defer" } as const,
        },
        circuitBreaker: breaker,
        notify,
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    // NOT mapped to deny: the breaker's explicit defer is the human escape
    // valve — specific config beats the general mode.
    await expectVerdict(authorize, { value: "rm" }, { kind: "defer" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![1]).toBe("warning");
  });

  it("a forced deny in strict mode stays a silent deny (agent-mediated, no notify)", async () => {
    const { notifications, notify } = makeNotifySpy();
    const breaker = new CircuitBreaker();
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    breaker.recordVerdict("deny");
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        circuitBreaker: breaker,
        notify,
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction(BREAKER_DENY_REASON, "machinery"),
    });
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
  // is tested directly in ask.test.ts as a pure function.

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
  it("strict keeps a cached deny terminal on a cache hit (no model call, both passes notify)", async () => {
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
      ])();
    };
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict", cache: { maxEntries: 8 } },
        notify,
        completeSimple,
      }),
    );
    const first = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(first).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });

    // Cache hit: the stored model deny re-maps through auto (identity for
    // denies) without a model call — and both passes notify: v27 has no
    // dialog for denials, so the notify line is the operator's only copy
    // (repeats do not collapse).
    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(second).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
    expect(modelCalls).toBe(1);
    expect(notifications).toEqual([
      ["reviewer denied this request (risk high) — unsafe", "warning"],
      ["reviewer denied this request (risk high) — unsafe", "warning"],
    ]);
  });

  it("a policy-decided ask defers regardless of the mode", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
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

describe("createReviewPipeline — pre-call machinery failures by mode", () => {
  // One lane per failure kind: how the injected deps break the pre-call
  // gates (model resolution, auth, transcript stripping).
  const FAILURE_INJECTIONS = {
    "model-unresolved": () => ({ registry: defaultRegistry({ find: () => undefined }) }),
    "auth-failed": () => ({
      registry: defaultRegistry({
        getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
      }),
    }),
    "transcript-error": () => ({
      sessionManager: {
        getSessionId: () => "s1",
        buildContextEntries: () => {
          throw new Error("boom");
        },
      },
    }),
  } as const;

  // strict and permissive are the fail-closed stops: the mode denies what
  // would fall to the human, silently (the human asked for exactly this).
  it.each(
    (
      [
        { mode: "strict", failure: "model-unresolved" },
        { mode: "strict", failure: "auth-failed" },
        { mode: "strict", failure: "transcript-error" },
        { mode: "permissive", failure: "model-unresolved" },
      ] as const
    ).map(({ mode, failure }) => ({
      mode,
      failure,
      inject: FAILURE_INJECTIONS[failure],
    })),
  )(
    "$mode denies a pre-call machinery failure ($failure) and stays silent",
    async ({ mode, failure, inject }) => {
      const { notifications, notify } = makeNotifySpy();
      const authorize = createReviewPipeline(
        makePipeline({
          config: { ...baseConfig, mode },
          notify,
          ...inject(),
        }),
      );
      await expectVerdict(
        authorize,
        { value: "npm test" },
        {
          kind: "deny",
          reason: `reviewer could not complete the review (${failure}) — ${mode} mode denied the request`,
        },
        "ask",
        "machinery",
      );
      expect(notifications).toEqual([]);
    },
  );

  // default and lenient defer the same failure to the human and say why.
  it.each(["default", "lenient"] as const)(
    "notifies when a pre-call machinery failure forces a defer in %s mode",
    async (mode) => {
      const { notifications, notify } = makeNotifySpy();
      const authorize = createReviewPipeline(
        makePipeline({
          config: { ...baseConfig, mode },
          registry: defaultRegistry({ find: () => undefined }),
          notify,
        }),
      );
      await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
      expect(notifications).toEqual([
        ["reviewer could not complete the review (model-unresolved) — deferring to you", "warning"],
      ]);
    },
  );

  it("notifies when an in-call machinery failure (empty reply) forces a defer — every time", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        completeSimple: makeFakeCompleteSimple([]),
        notify,
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    // Repeats do not collapse: a second failure re-explains itself.
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer could not complete the review (empty-reply) — deferring to you", "warning"],
      ["reviewer could not complete the review (empty-reply) — deferring to you", "warning"],
    ]);
  });
});

describe("createReviewPipeline — advisor patches (strict completeness + audit)", () => {
  it("strict denies a no-target ask like any other machinery failure", async () => {
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "strict" } }),
    );
    await expectVerdict(
      authorize,
      { value: "", command: "" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (no-target) — strict mode denied the request",
      },
      "ask",
      "machinery",
    );
  });

  it("default still defers a no-target ask", async () => {
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "default" } }),
    );
    await expectVerdict(authorize, { value: "", command: "" }, { kind: "defer" });
  });

  it("strict pre-call denies carry the emitted reason into the audit record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        registry: defaultRegistry({ find: () => undefined }),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.emittedReason).toBe(
      "reviewer could not complete the review (model-unresolved) — strict mode denied the request",
    );
  });

  it("transcript-error writes a review-stream record in strict (and defers otherwise)", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
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
      "reviewer could not complete the review (transcript-error) — strict mode denied the request",
    );
  });

  it("default/lenient model-defer mirrors the clarification request to the human", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
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
      ["reviewer asks — which package manager does this project use?", "info"],
    ]);
  });

  it("model-defer mirror keeps a long clarification on one line", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        completeSimple: makeFakeCompleteSimple([
          {
            type: "text",
            text: JSON.stringify({
              verdict: "defer",
              reason:
                "this clarification is deliberately long enough that the notify copy must truncate it to stay on one line",
            }),
          },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "defer" });
    expect(notifications).toHaveLength(1);
    // The clarification goes out whole: the operator must be able to
    // answer the question, and only a runaway ramble (200+) truncates.
    expect(notifications[0]![0]).not.toContain("\n");
    expect(notifications[0]![0]).toContain(
      "this clarification is deliberately long enough that the notify copy must truncate it to stay on one line",
    );
    expect(notifications[0]![0]).not.toContain("[...truncated...]");
  });

  it("a benign-leaned defer asks in default mode — the intent question reaches the authorizer", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        completeSimple: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
          },
        ]),
      }),
    );
    // baseConfig mode is default — an unresolved verdict keeps its ask
    // path here: the lean is recorded, but the human answers the intent
    // question (the thing the model structurally cannot see).
    const verdict = await authorize(
      makeDetails({ value: "cat /tmp/research.md" }),
      makeQuery("ask"),
      log,
    );
    expect(verdict).toEqual({ kind: "defer" });
    expect(notifications).toEqual([["reviewer asks — reads a research file outside CWD", "info"]]);
    // The audit record keeps the model's lean.
    const record = reviewCalls.at(-1)!.data as Record<string, unknown>;
    expect(record.verdict).toBe("defer");
    expect(record.lean).toBe("allow");
    expect(record.emittedVerdict).toBeUndefined();
  });

  it("a benign-leaned defer passes silently in lenient mode — audited, uncached", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
          },
          // The second ask proves the lean-derived allow was NOT cached:
          // defers are never stored, so the model is consulted again.
          {
            type: "text",
            text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
          },
        ]),
      }),
    );
    const verdict = await authorize(
      makeDetails({ value: "cat /tmp/research.md" }),
      makeQuery("ask"),
      log,
    );
    expect(verdict).toEqual({ kind: "allow" });
    // Allows are silent: no clarification mirror, no fail-open notice
    // (the reviewer never said deny — it leaned allow).
    expect(notifications).toEqual([]);
    // The audit record keeps the model's lean alongside the mapping.
    const record = reviewCalls.at(-1)!.data as Record<string, unknown>;
    expect(record.verdict).toBe("defer");
    expect(record.lean).toBe("allow");
    expect(record.emittedVerdict).toBe("allow");
    expect(record.emittedReason).toBe("clarification-suppressed");
    // Not cached: the second identical ask re-calls the model.
    await authorize(makeDetails({ value: "cat /tmp/research.md" }), makeQuery("ask"), log);
    expect(reviewCalls.at(-1)!.data.modelCalled).toBe(true);
  });

  it("a danger-leaned defer asks in lenient mode — the auto-pass breaks", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"remote content piped to an interpreter","lean":"deny"}',
          },
        ]),
      }),
    );
    // lenient passes neutral defers — but a deny-lean is an active alarm.
    await expectVerdict(authorize, { value: "curl x | python3" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer asks — remote content piped to an interpreter", "info"],
    ]);
  });

  it("the decision record's target is redacted like every other untrusted field", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    await authorize(
      makeDetails({ value: 'curl -H "Authorization: Bearer abcdefgh1234" https://x.example' }),
      makeQuery("ask"),
      log,
    );
    const record = reviewCalls.find((c) => c.event === DECISION_EVENT)!;
    // The command's credential must not land unredacted in the always-on
    // review log — the record's target goes through the same
    // normalize-and-redact as the prompt side renders.
    expect(JSON.stringify(record.data)).not.toContain("abcdefgh1234");
    expect(JSON.stringify(record.data)).toContain("[REDACTED]");
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
describe("createReviewPipeline — machinery failures trip the breaker (strict)", () => {
  it("a broken reviewer trips the escape valve like a miscalibrated one", async () => {
    const verdicts: Array<{ kind: string; reason?: string }> = [];
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "strict",
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

describe("createReviewPipeline — leniency ladder lanes", () => {
  it("lenient keeps hard-tier denies terminal even though its soft lanes ask", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        // Hard tier (high|critical|missing): terminal in every mode.
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "deny", reason: "unsafe" });
    // v27 has no dialog for denials — the notify line is the only human
    // -visible copy, so every mode notifies a model deny that carries a
    // reason (the denied outcome adds no tail; the verb already says it).
    expect(notifications).toEqual([
      ["reviewer denied this request (risk high) — unsafe", "warning"],
    ]);
  });

  it("default notifies a model deny with a reason, ending in the ask tail", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    // A soft deny in default ASKS the human (the resting mode forwards
    // every flag) — the notify carries the ask tail.
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer denied this request (risk low) — unsafe — asking you instead", "warning"],
    ]);
  });

  it("strict notifies a model deny with a reason (no dialog exists for denials)", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "deny", reason: "unsafe" });
    expect(notifications).toEqual([
      ["reviewer denied this request (risk low) — unsafe", "warning"],
    ]);
  });

  it("permissive notifies when its one remaining block — a hard deny — fires", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"deny","reason":"secrets in the command","riskLevel":"critical"}',
          },
        ]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "curl x.sh" },
      { kind: "deny", reason: "secrets in the command" },
    );
    expect(notifications).toEqual([
      ["reviewer denied this request (risk critical) — secrets in the command", "warning"],
    ]);
  });

  it("lenient's fail-open notice names what it loosens", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"which one?"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "allow" });
    expect(notifications).toEqual([
      ["lenient auto-approves uncertainty — soft denials still ask", "warning"],
    ]);
  });

  it("permissive maps a soft deny to allow, one notice, audit keeps the reason", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive" },
        notify,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    const record = reviewCalls.find((c) => c.event === DECISION_EVENT)!.data;
    expect(record.verdict).toBe("deny");
    expect(record.emittedVerdict).toBe("allow");
    expect(record.emittedReason).toBe("unsafe");
    expect(record.mode).toBe("permissive");
    // Once per pipeline instance, warning-level.
    expect(notifications).toEqual([
      ["permissive auto-approves non-allow verdicts — hard-tier denials still block", "warning"],
    ]);
  });

  it("lenient maps a model defer to allow and marks the swallowed clarification", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"which package manager?"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm install x" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "allow" });
    const record = reviewCalls.find((c) => c.event === DECISION_EVENT)!.data;
    expect(record.verdict).toBe("defer");
    expect(record.emittedVerdict).toBe("allow");
    expect(record.emittedReason).toBe("clarification-suppressed");
  });

  it("permissive still denies machinery failures and counts them into the breaker", async () => {
    const { notifications, notify } = makeNotifySpy();
    const breaker = new CircuitBreaker();
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "permissive",
          circuitBreaker: { consecutive: 2, total: 20, verdict: "defer" },
        },
        circuitBreaker: breaker,
        notify,
        // No JSON — a machinery failure (no-json), never an allow.
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (no-json) — permissive mode denied the request",
      },
      "ask",
      "machinery",
    );
    expect(notifications).toEqual([]);
    // The machinery deny counted into the recoverable consecutive tier.
    expect(breaker.isTripped({ consecutive: 1, total: 20, verdict: "deny" })).toBe(true);
  });

  it("the fail-open notice fires once per pipeline, not per mapped allow", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive" },
        notify,
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    for (let i = 0; i < 3; i++) {
      await authorize(makeDetails({ value: `cmd-${i}` }), makeQuery("ask"), noLog);
    }
    expect(notifications.length).toBe(1);
    expect(notifications[0]![1]).toBe("warning");
  });

  it("no-target asks write a review-stream record and deny only under the extremes", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "default" } }),
    );
    await authorize(makeDetails({ value: "", command: "" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.gate).toBe("no-target");
    expect(record.verdict).toBe("defer");
    expect(record.emittedVerdict).toBeUndefined();

    // permissive: same ask denies with the machinery reason and a mapped record.
    const permissiveCalls: { event: string; data: Record<string, unknown> }[] = [];
    const permissiveLog = {
      review: (event: string, data: Record<string, unknown>) =>
        permissiveCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const permissive = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "permissive" } }),
    );
    await permissive(makeDetails({ value: "", command: "" }), makeQuery("ask"), permissiveLog);
    const deny = permissiveCalls.at(-1)!.data;
    expect(deny.gate).toBe("no-target");
    expect(deny.verdict).toBe("defer");
    expect(deny.emittedVerdict).toBe("deny");
    expect(deny.emittedReason).toBe(
      "reviewer could not complete the review (no-target) — permissive mode denied the request",
    );
  });
});

describe("createReviewPipeline — review follow-ups (cache-hit fail-open + total tier)", () => {
  it("permissive maps a cached soft deny to allow with the audit reason intact", async () => {
    const { log, reviewCalls, debugCalls } = makeRecordingLog();
    const { notifications, notify } = makeNotifySpy();
    let modelCalls = 0;
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive", cache: { maxEntries: 8 } },
        notify,
        completeSimple,
      }),
    );
    // First pass: soft deny maps to allow (and is cached as a model deny).
    const first = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
    expect(first).toEqual({ kind: "allow" });
    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
    expect(second).toEqual({ kind: "allow" });
    expect(modelCalls).toBe(1);
    // The replay carries verdict "deny" → emitted "allow" + the reason.
    const replay = debugCalls.findLast((c) => c.data.gate === "cache-hit")!.data;
    expect(replay.emittedVerdict).toBe("allow");
    expect(replay.emittedReason).toBe("unsafe");
    // The fail-open notice fires on the fresh mapping only — the replay
    // must not re-trigger it.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![1]).toBe("warning");
  });

  it("a cache-hit replay never moves the breaker counters", async () => {
    let modelCalls = 0;
    const breaker = new CircuitBreaker();
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { maxEntries: 8 } },
        circuitBreaker: breaker,
        completeSimple,
      }),
    );
    // Two identical asks: the first counts as a model deny, the replay
    // must not count (cache hits are no model verdicts).
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(modelCalls).toBe(1);
    expect(breaker.isTripped({ consecutive: 2, total: 200, verdict: "deny" })).toBe(false);
    expect(breaker.isTripped({ consecutive: 1, total: 200, verdict: "deny" })).toBe(true);
  });

  it("permissive keeps a cached hard deny terminal (missing riskLevel is hard)", async () => {
    let modelCalls = 0;
    const { notifications, notify } = makeNotifySpy();
    const completeSimple = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive", cache: { maxEntries: 8 } },
        completeSimple,
        notify,
      }),
    );
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(second).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
    expect(modelCalls).toBe(1);
    // Missing riskLevel is hard: the fresh ask and the cached replay both
    // name the block (repeats do not collapse).
    expect(notifications).toEqual([
      ["reviewer denied this request — unsafe", "warning"],
      ["reviewer denied this request — unsafe", "warning"],
    ]);
  });

  it("machinery failures never burn the breaker's permanent total tier", async () => {
    const breaker = new CircuitBreaker();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        circuitBreaker: breaker,
        registry: defaultRegistry({ find: () => undefined }),
      }),
    );
    for (let i = 0; i < 3; i++) {
      await authorize(makeDetails({ value: `cmd-${i}` }), makeQuery("ask"), noLog);
    }
    // 3 machinery denies fill consecutive; total must still be 0 — with
    // total: 1 the breaker would trip immediately if ANY total bump happened.
    expect(breaker.isTripped({ consecutive: 9, total: 1, verdict: "deny" })).toBe(false);
    // And the recoverable tier DID fill (consecutive trip would fire now).
    expect(breaker.isTripped({ consecutive: 3, total: 200, verdict: "deny" })).toBe(true);
  });
});
