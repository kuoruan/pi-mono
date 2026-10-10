/**
 * Pool-level tests: ordered failover over stub lane adapters. The pool
 * never interprets backend errors — these tests pin the orchestration:
 * order, audit, cacheability, terminal short-circuit, and exhaustion.
 */

import { describe, expect, it } from "vitest";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import type { AttemptResult, LaneAdapter, PoolEndpoint } from "#src/review/pool.ts";
import { createReviewerPool } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import type {
  EngineCallContext,
  EngineMachineryFailure,
  EngineReviewResult,
} from "#src/review/reviewer-engine.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";
import { makeDetails } from "#test/fixtures.ts";

import { type RecordingLogSink, makeMergedRecordingLog } from "./pipeline-helpers.ts";

const ctx = (log: RecordingLogSink): EngineCallContext => ({
  transcript: { trustedIntent: ["x"], toolCalls: [], strippedCount: 0 },
  request: { ask: buildAskContext(makeDetails({ value: "x" }), "/project"), target: "x" },
  log,
  requestId: "pool-test",
});

const chatEndpoint = (model: string, timeoutMs = 1000): PoolEndpoint => ({
  lane: "chat",
  provider: "anthropic",
  model,
  timeoutMs,
  temperature: undefined,
  // The lane's bare audit identity — the pool appends the walk position.
  id: `anthropic/${model}`,
});

const classifierEndpoint = (model: string, timeoutMs = 1000): PoolEndpoint => ({
  lane: "classifier",
  backend: "direct",
  provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
  model,
  timeoutMs,
  id: `typesafe/${model}`,
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
 * @param script - Maps an endpoint to the scripted disposition.
 * @returns A lane adapter replaying the script.
 */
function stubAdapter(script: (endpoint: PoolEndpoint) => AttemptResult): LaneAdapter {
  return { attempt: async (endpoint, _ctx, _spec) => script(endpoint) };
}

function pool(
  endpoints: PoolEndpoint[],
  script: (endpoint: PoolEndpoint) => AttemptResult,
  lanes: Array<PoolEndpoint["lane"]> = ["chat", "classifier"],
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
    const engine = pool([chatEndpoint("a"), chatEndpoint("b")], () => {
      calls++;
      return { kind: "answered", result: answered("allow", "m") };
    });
    const { events, log } = makeMergedRecordingLog();
    const result = await engine.review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.cacheable).toBeUndefined();
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it("advances in order on retryable, marks backup verdicts uncached, and audits each hop", async () => {
    const { events, log } = makeMergedRecordingLog();
    const engine = pool([chatEndpoint("a"), classifierEndpoint("b"), chatEndpoint("c")], (e) =>
      e.model === "c"
        ? { kind: "answered", result: answered("allow", e.id) }
        : {
            kind: "retryable",
            reason: "http-429",
            finalize: () => answered("defer", e.id),
          },
    );
    const result = await engine.review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.cacheable).toBe(false);
    expect(events.map((e) => e.event)).toEqual([FALLBACK_EVENT, FALLBACK_EVENT]);
    expect(events[0]?.details).toMatchObject({
      failedEndpoint: 0,
      nextEndpoint: 1,
      // The failed endpoint's own identity, position included.
      modelId: "anthropic/a",
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
    const engine = pool([chatEndpoint("a"), chatEndpoint("b")], () => ({
      kind: "terminal",
      result: failure,
    }));
    const { events, log } = makeMergedRecordingLog();
    const result = await engine.review(ctx(log));
    expect(isMachineryFailure(result)).toBe(true);
    expect(events).toEqual([]);
  });

  it("invokes finalize on exhaustion and stamps wall-clock latency", async () => {
    let elapsed = 0;
    const { events, log } = makeMergedRecordingLog();
    const ticking: LaneAdapter = {
      attempt: async (endpoint, c, spec) => {
        elapsed += 2_250;
        return stubAdapter((e) => ({
          kind: "retryable",
          reason: "http-503",
          finalize: () => answered("defer", e.id),
        })).attempt(endpoint, c, spec);
      },
    };
    const engine = createReviewerPool({
      endpoints: [chatEndpoint("a"), chatEndpoint("b")],
      adapters: { chat: ticking, classifier: ticking },
      now: () => elapsed,
    });
    const result = await engine.review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(result.modelId).toBe("anthropic/b (fallback 1)");
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
    const engine = pool([chatEndpoint("a"), chatEndpoint("b")], (e) =>
      e.model === "a"
        ? { kind: "retryable", reason: "timeout", finalize: () => failure }
        : { kind: "terminal", result: failure },
    );
    const { log } = makeMergedRecordingLog();
    const result = await engine.review(ctx(log));
    expect(isMachineryFailure(result)).toBe(true);
    expect("cacheable" in result).toBe(false);
  });

  it("caps the walk at the budget and trims per-endpoint timeouts", async () => {
    let elapsed = 0;
    const seenTimeouts: number[] = [];
    const seenWalk: number[] = [];
    // Unscoped from the parent on purpose: shares the file-level pin shape.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const script = (_endpoint: PoolEndpoint): AttemptResult => ({
      kind: "retryable",
      reason: "http-503",
      finalize: () => answered("defer", "m"),
    });
    const trimming: LaneAdapter = {
      attempt: async (endpoint, c, spec) => {
        seenTimeouts.push(spec.attemptTimeoutMs);
        seenWalk.push(spec.walkRemainingMs);
        // The budget trims, never extends: endpoint 10s stays 10s.
        expect(spec.attemptTimeoutMs).toBeLessThanOrEqual(endpoint.timeoutMs);
        elapsed += 5_000;
        return stubAdapter(script).attempt(endpoint, c, spec);
      },
    };
    const { log } = makeMergedRecordingLog();
    // Budget 12s over three 10s endpoints, clock advancing 5s per hop:
    // 12s→10s, then 7s→7s; remaining 2s meets the floor, so all three run
    // with trimmed budgets and the last failure (index 2) finalizes.
    const result = await createReviewerPool({
      endpoints: [chatEndpoint("a", 10_000), chatEndpoint("b", 10_000), chatEndpoint("c", 10_000)],
      adapters: { chat: trimming, classifier: trimming },
      walkBudgetMs: 12_000,
      now: () => elapsed,
    }).review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(result.modelId).toBe("anthropic/c (fallback 2)");
    expect(seenTimeouts).toEqual([10_000, 7_000, 2_000]);
    // The walk budget itself, as the lane sees it: what the SDK retries are
    // bounded by, not the per-attempt timeout above it.
    expect(seenWalk).toEqual([12_000, 7_000, 2_000]);
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
          reason: "http-503",
          // The tag rides the verdict kind, not the identity: the pool owns
          // identity stamping, so both walks would end on the same endpoint's
          // id — only a review-local fact tells them apart.
          finalize: () => answered(tag.startsWith("first-") ? "deny" : "allow", "m"),
        };
      },
    };
    const racingPool = createReviewerPool({
      endpoints: [chatEndpoint("a"), chatEndpoint("b")],
      adapters: { chat: racing, classifier: racing },
      walkBudgetMs: 60_000,
    });
    const { log } = makeMergedRecordingLog();
    const first = racingPool.review(ctx(log));
    await Promise.resolve(); // first review reaches its gate
    const second = racingPool.review(ctx(log));
    const secondResult = await second;
    releaseFirst();
    const firstResult = await first;
    if (isMachineryFailure(firstResult) || isMachineryFailure(secondResult))
      throw new Error("unexpected machinery");
    expect(secondResult.outcome.verdict.kind).toBe("allow");
    expect(firstResult.outcome.verdict.kind).toBe("deny");
  });

  it("stops the walk when the remaining budget falls below the floor", async () => {
    let elapsed = 0;
    const tickAdapter: LaneAdapter = {
      attempt: async (endpoint, _c, _spec) => {
        elapsed += 9_000;
        return {
          kind: "retryable",
          reason: "http-503",
          finalize: () => answered("defer", endpoint.id),
        };
      },
    };
    const { events, log } = makeMergedRecordingLog();
    // Budget 12s: after the first 9s attempt 3s remain — still above the
    // 2s floor, so the second attempt runs; its 9s push remaining below
    // the floor and the walk finalizes on the second failure without
    // contacting the third endpoint — only the taken hop is audited.
    const result = await createReviewerPool({
      endpoints: [chatEndpoint("a", 10_000), chatEndpoint("b", 10_000), chatEndpoint("c", 10_000)],
      adapters: { chat: tickAdapter, classifier: tickAdapter },
      walkBudgetMs: 12_000,
      now: () => elapsed,
    }).review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.modelId).toBe("anthropic/b (fallback 1)");
    // One hop audited (0→1); the third endpoint never runs.
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ failedEndpoint: 0, nextEndpoint: 1 });
  });

  it("audits a hop only for an endpoint the walk actually contacts", async () => {
    // The clock moves on every read, so a hop audited at the failure and the
    // following floor check saw different budgets — that recorded a failover
    // to an endpoint the walk then skipped. With 4.5s of budget and 1s per
    // read, the second iteration has 1.5s left and finalizes instead. The
    // assertion is the invariant, not the walk's shape: reading the clock
    // once per iteration leaves more budget, so how far the walk gets is an
    // artifact of this clock, not a contract.
    let t = 0;
    let calls = 0;
    const adapter = stubAdapter((endpoint) => {
      calls++;
      return {
        kind: "retryable",
        reason: "http-503",
        finalize: () => answered("defer", endpoint.id),
      };
    });
    const { events, log } = makeMergedRecordingLog();
    const result = await createReviewerPool({
      endpoints: [chatEndpoint("a"), chatEndpoint("b"), chatEndpoint("c")],
      adapters: { chat: adapter, classifier: adapter },
      walkBudgetMs: 4_500,
      now: () => (t += 1_000),
    }).review(ctx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("defer");
    expect(events.map((event) => event.details)).toMatchObject([
      { failedEndpoint: 0, nextEndpoint: 1 },
    ]);
    for (const event of events) {
      const { nextEndpoint } = event.details as { nextEndpoint: number };
      expect(nextEndpoint).toBeLessThan(calls);
    }
  });

  it("defaults the budget to twice the primary timeout, floored at 30s", async () => {
    // Primary 5s → the 30s floor beats 2×primary, and the clock makes that
    // visible: after a 27s hop the second attempt is trimmed to the 3s left.
    // With a 10s budget (2×primary, no floor) the walk would already have
    // ended at the floor and the second attempt would never run.
    let elapsed = 0;
    const seen: number[] = [];
    // Unscoped from the parent on purpose: shares the file-level pin shape.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const script = (_endpoint: PoolEndpoint): AttemptResult => ({
      kind: "retryable",
      reason: "timeout",
      finalize: () => answered("defer", "m"),
    });
    const recording: LaneAdapter = {
      attempt: async (endpoint, c, spec) => {
        seen.push(spec.attemptTimeoutMs);
        elapsed += 27_000;
        return stubAdapter(script).attempt(endpoint, c, spec);
      },
    };
    const { log } = makeMergedRecordingLog();
    await createReviewerPool({
      endpoints: [chatEndpoint("a", 5_000), chatEndpoint("b", 5_000)],
      adapters: { chat: recording, classifier: recording },
      now: () => elapsed,
    }).review(ctx(log));
    expect(seen).toEqual([5_000, 3_000]);
  });

  it("passes the walk-level hasFailover through to the adapter", async () => {
    const seen: boolean[] = [];
    let first = true;
    const adapter: LaneAdapter = {
      attempt: async (endpoint, _c, spec) => {
        seen.push(spec.hasFailover);
        if (first) {
          first = false;
          return { kind: "answered", result: answered("allow", endpoint.id) };
        }
        return {
          kind: "retryable",
          reason: "timeout",
          finalize: () => answered("allow", endpoint.id),
        };
      },
    };
    const { log } = makeMergedRecordingLog();
    await createReviewerPool({
      endpoints: [chatEndpoint("a")],
      adapters: { chat: adapter, classifier: adapter },
    }).review(ctx(log));
    first = false;
    await createReviewerPool({
      endpoints: [chatEndpoint("a"), chatEndpoint("b")],
      adapters: { chat: adapter, classifier: adapter },
    }).review(ctx(log));
    // The flag is a property of the walk, not of the position: a
    // single-endpoint pool reports false (its lone attempt keeps the
    // transport's retries), and EVERY attempt of a two-endpoint pool reports
    // true — the walk is the retry, so even the last endpoint runs without
    // the transport's own retries spending its budget again.
    expect(seen).toEqual([false, true, true]);
  });
});
