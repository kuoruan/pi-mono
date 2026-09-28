/**
 * Pool-level tests: ordered failover over stub lane adapters. The pool
 * never interprets backend errors — these tests pin the orchestration:
 * order, audit, cacheability, terminal short-circuit, and exhaustion.
 */

import { describe, expect, it } from "vitest";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import type { AttemptResult, LaneAdapter, PoolEndpoint } from "#src/review/pool.ts";
import { WALK_BUDGET_FLOOR_MS, createReviewerPool } from "#src/review/pool.ts";
import type {
  EngineCallContext,
  EngineMachineryFailure,
  EngineReviewResult,
} from "#src/review/reviewer-engine.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";

function recordingLog() {
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const log = {
    review: (event: string, details: Record<string, unknown>) => events.push({ event, details }),
    debug: (event: string, details: Record<string, unknown>) => events.push({ event, details }),
  };
  return { events, log };
}

const ctx = (log: ReturnType<typeof recordingLog>["log"]): EngineCallContext =>
  ({
    transcript: { trustedIntent: ["x"], toolCalls: [], strippedCount: 0 },
    request: { ask: {} as never, target: "x" },
    log,
    requestId: "pool-test",
  }) as EngineCallContext;

const llmEndpoint = (model: string, timeoutMs = 1000): PoolEndpoint => ({
  lane: "llm",
  provider: "anthropic",
  model,
  timeoutMs,
});

const jevEndpoint = (model: string, timeoutMs = 1000): PoolEndpoint => ({
  lane: "jev",
  provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
  model,
  timeoutMs,
});

/**
 * Fake review result for pool orchestration tests.
 *
 * @param verdict - The verdict kind.
 * @param modelId - The audit identity.
 * @returns A minimal engine result.
 */
const answered = (verdict: "allow" | "deny" | "defer", modelId: string): EngineReviewResult => ({
  outcome: { verdict: { kind: verdict }, latencyMs: 1 },
  modelId,
});

/**
 * Stub adapter driven by a per-endpoint script.
 *
 * @param script - Maps (endpoint, index) to the scripted disposition.
 * @returns A lane adapter replaying the script.
 */
function stubAdapter(
  script: (endpoint: PoolEndpoint, index: number) => AttemptResult,
): LaneAdapter {
  return { attempt: async (endpoint, _ctx, spec) => script(endpoint, spec.index) };
}

function pool(
  endpoints: PoolEndpoint[],
  script: (endpoint: PoolEndpoint, index: number) => AttemptResult,
  lanes: Array<PoolEndpoint["lane"]> = ["llm", "jev"],
  now?: () => number,
) {
  const adapter = stubAdapter(script);
  return createReviewerPool({
    endpoints,
    adapters: Object.fromEntries(lanes.map((lane) => [lane, adapter])) as Record<
      PoolEndpoint["lane"],
      LaneAdapter
    >,
    ...(now ? { now } : {}),
  });
}

describe("reviewer pool", () => {
  it("returns the primary verdict without touching backups", async () => {
    let calls = 0;
    const engine = pool([llmEndpoint("a"), llmEndpoint("b")], () => {
      calls++;
      return { kind: "answered", result: answered("allow", "m") };
    });
    const { events, log } = recordingLog();
    const result = await engine.review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.cacheable).toBeUndefined();
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it("advances in order on retryable, marks backup verdicts uncached, and audits each hop", async () => {
    const { events, log } = recordingLog();
    const engine = pool([llmEndpoint("a"), jevEndpoint("b"), llmEndpoint("c")], (_e, i) =>
      i < 2
        ? {
            kind: "retryable",
            modelId: `m${i}`,
            reason: "http-429",
            finalize: () => answered("defer", `m${i}`),
          }
        : { kind: "answered", result: answered("allow", "m2") },
    );
    const result = await engine.review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.cacheable).toBe(false);
    expect(events.map((e) => e.event)).toEqual([FALLBACK_EVENT, FALLBACK_EVENT]);
    expect(events[0]?.details).toMatchObject({
      failedEndpoint: 0,
      nextEndpoint: 1,
      modelId: "m0",
      reason: "http-429",
    });
    expect(events[1]?.details).toMatchObject({ failedEndpoint: 1, nextEndpoint: 2 });
  });

  it("ships terminal results without failover", async () => {
    const failure: EngineMachineryFailure = {
      ok: false,
      kind: "auth-failed",
      modelId: "m0",
      detail: "denied",
    };
    const engine = pool([llmEndpoint("a"), llmEndpoint("b")], () => ({
      kind: "terminal",
      result: failure,
    }));
    const { events, log } = recordingLog();
    const result = await engine.review(ctx(log));
    expect(isMachineryFailure(result)).toBe(true);
    expect(events).toEqual([]);
  });

  it("invokes finalize on exhaustion and stamps wall-clock latency", async () => {
    let elapsed = 0;
    const { events, log } = recordingLog();
    const ticking: LaneAdapter = {
      attempt: async (endpoint, c, spec) => {
        elapsed += 2_250;
        return stubAdapter((_e, i) => ({
          kind: "retryable",
          modelId: `m${i}`,
          reason: "http-503",
          finalize: () => answered("defer", `m${i}`),
        })).attempt(endpoint, c, spec);
      },
    };
    const engine = createReviewerPool({
      endpoints: [llmEndpoint("a"), llmEndpoint("b")],
      adapters: { llm: ticking, jev: ticking },
      now: () => elapsed,
    });
    const result = await engine.review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(result.modelId).toBe("m1");
    expect(result.outcome.latencyMs).toBe(4_500);
    // Exhaustion settles through ship: the backup verdict never caches.
    expect(result.cacheable).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("never caches machinery results, even from a backup", async () => {
    const failure: EngineMachineryFailure = {
      ok: false,
      kind: "model-unresolved",
      modelId: "m1",
      detail: "m1",
    };
    const engine = pool([llmEndpoint("a"), llmEndpoint("b")], (_e, i) =>
      i === 0
        ? { kind: "retryable", modelId: "m0", reason: "timeout", finalize: () => failure }
        : { kind: "terminal", result: failure },
    );
    const { log } = recordingLog();
    const result = await engine.review(ctx(log));
    expect(isMachineryFailure(result)).toBe(true);
    expect("cacheable" in result).toBe(false);
  });

  it("caps the walk at the budget and trims per-endpoint timeouts", async () => {
    let elapsed = 0;
    const seenTimeouts: number[] = [];
    // Unscoped from the parent on purpose: shares the file-level pin shape.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const script = (_endpoint: PoolEndpoint, index: number): AttemptResult => ({
      kind: "retryable",
      modelId: `m${index}`,
      reason: "http-503",
      finalize: () => answered("defer", `m${index}`),
    });
    const trimming: LaneAdapter = {
      attempt: async (endpoint, c, spec) => {
        seenTimeouts.push(spec.timeoutMs);
        // The budget trims, never extends: endpoint 10s stays 10s.
        expect(spec.timeoutMs).toBeLessThanOrEqual(endpoint.timeoutMs);
        elapsed += 5_000;
        return stubAdapter(script).attempt(endpoint, c, spec);
      },
    };
    const { log } = recordingLog();
    // Budget 12s over three 10s endpoints, clock advancing 5s per hop:
    // 12s→10s, then 7s→7s; remaining 2s meets the floor, so all three run
    // with trimmed budgets and the last failure (index 2) finalizes.
    const result = await createReviewerPool({
      endpoints: [llmEndpoint("a", 10_000), llmEndpoint("b", 10_000), llmEndpoint("c", 10_000)],
      adapters: { llm: trimming, jev: trimming },
      walkBudgetMs: 12_000,
      now: () => elapsed,
    }).review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(result.modelId).toBe("m2");
    expect(seenTimeouts).toEqual([10_000, 7_000, 2_000]);
  });

  it("keeps concurrent reviews isolated from each other", async () => {
    // Deterministic interleave: call1 = first/i0 (gated), call2 =
    // second/i0, call3 = second/i1 (second completes), call4 = first/i1.
    // With shared per-pool state, the first review would finalize with
    // the second review's failure.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const tags = ["first-i0", "second-i0", "second-i1", "first-i1"];
    let calls = 0;
    const racing: LaneAdapter = {
      attempt: async (_endpoint, _c, _spec) => {
        const tag = tags[calls] ?? `unknown-${calls}`;
        calls += 1;
        if (tag === "first-i0") await gate;
        return {
          kind: "retryable",
          modelId: tag,
          reason: "http-503",
          finalize: () => answered("defer", tag),
        };
      },
    };
    const racingPool = createReviewerPool({
      endpoints: [llmEndpoint("a"), llmEndpoint("b")],
      adapters: { llm: racing, jev: racing },
      walkBudgetMs: 60_000,
    });
    const { log } = recordingLog();
    const first = racingPool.review(ctx(log));
    await Promise.resolve(); // first review reaches its gate
    const second = racingPool.review(ctx(log));
    const secondResult = await second;
    releaseFirst();
    const firstResult = await first;
    if (isMachineryFailure(firstResult) || isMachineryFailure(secondResult))
      throw new Error("unexpected machinery");
    expect(secondResult.modelId).toBe("second-i1");
    expect(firstResult.modelId).toBe("first-i1");
  });

  it("stops the walk when the remaining budget falls below the floor", async () => {
    let elapsed = 0;
    const tickAdapter: LaneAdapter = {
      attempt: async (endpoint, _c, spec) => {
        elapsed += 9_000;
        return {
          kind: "retryable",
          modelId: `m${spec.index}`,
          reason: "http-503",
          finalize: () => answered("defer", `m${spec.index}`),
        };
      },
    };
    const { events, log } = recordingLog();
    // Budget 12s: after the first 9s attempt 3s remain — still above the
    // 2s floor, so the second attempt runs; its 9s push remaining below
    // the floor and the walk finalizes on the second failure without
    // contacting the third endpoint — only the taken hop is audited.
    const result = await createReviewerPool({
      endpoints: [llmEndpoint("a", 10_000), llmEndpoint("b", 10_000), llmEndpoint("c", 10_000)],
      adapters: { llm: tickAdapter, jev: tickAdapter },
      walkBudgetMs: 12_000,
      now: () => elapsed,
    }).review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.modelId).toBe("m1");
    // One hop audited (0→1); the third endpoint never runs.
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ failedEndpoint: 0, nextEndpoint: 1 });
  });

  it("defaults the budget to twice the primary timeout, floored at 30s", async () => {
    const seen: number[] = [];
    const script = (endpoint: PoolEndpoint, _index: number): AttemptResult => {
      seen.push(endpoint.timeoutMs);
      return {
        kind: "retryable",
        modelId: "m",
        reason: "timeout",
        finalize: () => answered("defer", "m"),
      };
    };
    const { log } = recordingLog();
    // Primary 5s → budget 30s floor: second endpoint keeps its own 5s.
    await createReviewerPool({
      endpoints: [llmEndpoint("a", 5_000), llmEndpoint("b", 5_000)],
      adapters: { llm: stubAdapter(script), jev: stubAdapter(script) },
    }).review(ctx(log));
    expect(seen).toEqual([5_000, 5_000]);
    expect(WALK_BUDGET_FLOOR_MS).toBe(2_000);
  });

  it("passes singleEndpoint through to the adapter", async () => {
    const seen: boolean[] = [];
    let first = true;
    const adapter: LaneAdapter = {
      attempt: async (_e, _c, spec) => {
        seen.push(spec.singleEndpoint);
        if (first) {
          first = false;
          return { kind: "answered", result: answered("allow", "m") };
        }
        return {
          kind: "retryable",
          modelId: "m",
          reason: "timeout",
          finalize: () => answered("allow", "m"),
        };
      },
    };
    const { log } = recordingLog();
    await createReviewerPool({
      endpoints: [llmEndpoint("a")],
      adapters: { llm: adapter, jev: adapter },
    }).review(ctx(log));
    first = false;
    await createReviewerPool({
      endpoints: [llmEndpoint("a"), llmEndpoint("b")],
      adapters: { llm: adapter, jev: adapter },
    }).review(ctx(log));
    // Single pool: one attempt (true). Two-endpoint pool: both attempts (false, false).
    expect(seen).toEqual([true, false, false]);
  });
});
