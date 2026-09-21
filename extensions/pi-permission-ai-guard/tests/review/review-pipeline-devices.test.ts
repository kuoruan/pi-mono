/**
 * Stateful-device tests for the review pipeline: the circuit breaker
 * (thresholds, epochs, short-circuits) and the verdict cache (keys,
 * misses, context sensitivity), plus the review follow-ups they gate.
 */

import { describe, expect, it } from "vitest";

import { BREAKER_DENY_REASON } from "#src/audit/decision-record.ts";
import { CACHE_LOOKUP_EVENT } from "#src/audit/events.ts";
import { CircuitBreaker } from "#src/review/circuit-breaker.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { VerdictCache } from "#src/review/verdict-cache.ts";
import { withAgentInstruction } from "#src/review/verdict-copy.ts";
import { bashPayload, makeDetails } from "#test/fixtures.ts";

import {
  baseConfig,
  makeFakeCompleteSimple,
  makeSessionManagerWith,
  makeQuery,
  noLog,
  makeRecordingLog,
  makeNotifySpy,
  expectVerdict,
  defaultRegistry,
  makePipeline,
  makeEngine,
} from "./pipeline-helpers.ts";

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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
          ]),
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([
              { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
            ])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([
              { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
            ])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([
              { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
            ])();
          },
        }),
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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
        }),
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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
        }),
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
        engine: makeEngine({
          modelCall: async () =>
            makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])(),
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
      }),
    );
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(1);
    // Same command + same (empty) intent → cache hit
    const v = await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    expect(v).toEqual({ kind: "allow" });
    expect(modelCalled).toBe(1);
  });

  it("hits when only intervening tool calls change (no new user message)", async () => {
    const cache = new VerdictCache();
    let modelCalled = 0;
    const sessionEntries: unknown[] = [];
    const sessionManager = {
      getSessionId: () => "s1",
      buildContextEntries: () => sessionEntries as never,
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { ...baseConfig.cache, maxEntries: 5 } },
        sessionManager,
        verdictCache: cache,
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
      }),
    );
    // First call: no tool calls yet → model runs, verdict cached.
    await authorize(makeDetails({ value: "ls -la" }), makeQuery("ask"), noLog);
    expect(modelCalled).toBe(1);
    // An intervening tool call enters the transcript's untrusted-tool-calls
    // section, but the context key covers trusted intent only — the same
    // command with no new user message must hit without re-running the model.
    sessionEntries.push({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "write", arguments: { path: "x" } }],
      },
    });
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            // Always defer — should never be cached.
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          modelCall: async () => {
            modelCalled = true;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
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
        engine: makeEngine({
          registry: defaultRegistry({
            getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
          }),
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

describe("createReviewPipeline — review follow-ups (cache-hit fail-open + total tier)", () => {
  it("permissive maps a cached soft deny to allow with the audit reason intact", async () => {
    const { log, debugCalls } = makeRecordingLog();
    const { notifications, notify } = makeNotifySpy();
    let modelCalls = 0;
    const modelCall = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive", cache: { maxEntries: 8 } },
        notify,
        engine: makeEngine({ modelCall }),
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
    const modelCall = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { maxEntries: 8 } },
        circuitBreaker: breaker,
        engine: makeEngine({ modelCall }),
      }),
    );
    // Two identical asks: the first counts as a model deny, the replay
    // must not count (cache hits are no model verdicts).
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(modelCalls).toBe(1);
    expect(breaker.trippedTier({ consecutive: 2, total: 200, verdict: "deny" })).toBeUndefined();
    expect(breaker.trippedTier({ consecutive: 1, total: 200, verdict: "deny" })).toBeDefined();
  });

  it("permissive keeps a cached hard deny terminal (missing riskLevel is hard)", async () => {
    let modelCalls = 0;
    const { notifications, notify } = makeNotifySpy();
    const modelCall = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive", cache: { maxEntries: 8 } },
        engine: makeEngine({ modelCall }),
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
        engine: makeEngine({ registry: defaultRegistry({ find: () => undefined }) }),
      }),
    );
    for (let i = 0; i < 3; i++) {
      await authorize(makeDetails({ value: `cmd-${i}` }), makeQuery("ask"), noLog);
    }
    // 3 machinery denies fill consecutive; total must still be 0 — with
    // total: 1 the breaker would trip immediately if ANY total bump happened.
    expect(breaker.trippedTier({ consecutive: 9, total: 1, verdict: "deny" })).toBeUndefined();
    // And the recoverable tier DID fill (consecutive trip would fire now).
    expect(breaker.trippedTier({ consecutive: 3, total: 200, verdict: "deny" })).toBeDefined();
  });
});
