import { describe, expect, it } from "vitest";

import { CircuitBreaker, accountModelOutcome, consumeTrip } from "#src/review/circuit-breaker.ts";

const cb = { consecutive: 3, total: 20, verdict: "deny" as const };
describe("CircuitBreaker", () => {
  it("does not trip below the consecutive threshold", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(s.trippedTier(cb)).toBeUndefined();
  });

  it("trippedTier is a pure query — resetConsecutive is the separate, visible step", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(s.trippedTier(cb)).toBeDefined();
    // The pure query keeps reporting tripped until the caller resets.
    expect(s.trippedTier(cb)).toBeDefined();
    s.resetConsecutive();
    // Fresh consecutive window — next check won't trip until 3 more denies.
    expect(s.trippedTier(cb)).toBeUndefined();
  });

  it("allow resets the consecutive counter", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    s.recordVerdict("allow");
    // allow broke the streak, so consecutive is 0 → not tripped
    expect(s.trippedTier(cb)).toBeUndefined();
  });

  it("total is a permanent trip (resetConsecutive cannot clear it)", () => {
    const s = new CircuitBreaker();
    for (let i = 0; i < 20; i++) s.recordVerdict("deny");
    expect(s.trippedTier(cb)).toBeDefined();
    // total stays at 20; the reset is moot on the hard tier — still tripped.
    s.resetConsecutive();
    expect(s.trippedTier(cb)).toBeDefined();
  });

  it("does not count a breaker short-circuit or cache hit (caller responsibility)", () => {
    // The breaker only counts model verdicts via recordVerdict. If the caller
    // short-circuits (breaker trip or cache hit) without calling recordVerdict,
    // totals don't move. This is the no-double-count invariant.
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(s.trippedTier(cb)).toBeDefined(); // trip → total still 3
    s.resetConsecutive();
    expect(s.trippedTier(cb)).toBeUndefined(); // consecutive 0, total 3 < 20
  });

  it("defer does not change counters", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("defer");
    s.recordVerdict("defer");
    s.recordVerdict("defer");
    expect(s.trippedTier(cb)).toBeUndefined();
  });
});

describe("breaker accounting steps", () => {
  it("consumeTrip combines the query and the visible reset in one step", () => {
    const s = new CircuitBreaker();
    const config = { consecutive: 2, total: 20, verdict: "deny" as const };
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    // Below threshold: reports not-tripped and never mutates.
    expect(consumeTrip(s, { ...config, consecutive: 3 })).toEqual({ tripped: false });
    expect(s.trippedTier({ ...config, consecutive: 3 })).toBeUndefined();
    // At threshold: names the tier and consumes the recoverable tier.
    expect(consumeTrip(s, config)).toEqual({
      tripped: true,
      tier: "consecutive",
      totalNoticeDue: false,
    });
    expect(consumeTrip(s, config)).toEqual({ tripped: false }); // window reset
  });

  it("the total tier claims its one-time notice and resetAll re-arms it", () => {
    const s = new CircuitBreaker();
    const config = { consecutive: 3, total: 2, verdict: "deny" as const };
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    const first = consumeTrip(s, config);
    expect(first).toEqual({ tripped: true, tier: "total", totalNoticeDue: true });
    // The persistent total tier: still tripped on every ask, but the
    // notice fired once per epoch.
    expect(consumeTrip(s, config)).toEqual({
      tripped: true,
      tier: "total",
      totalNoticeDue: false,
    });
    // A manual reset clears both tiers, re-arms the notice, and reports
    // the tier it cleared (the resetBreaker seam's contract).
    expect(s.resetAll(config)).toBe("total");
    expect(consumeTrip(s, config)).toEqual({ tripped: false });
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(consumeTrip(s, config)).toEqual({
      tripped: true,
      tier: "total",
      totalNoticeDue: true,
    });
    // Resetting an already-clear breaker reports undefined (the "was
    // tripped" copy omits its parenthetical).
    s.resetAll(config);
    expect(s.resetAll(config)).toBeUndefined();
  });

  it("accountModelOutcome records the model verdict and credits machinery denials only", () => {
    const s = new CircuitBreaker();
    // A machinery denial: original defer + emitted deny + non-model-defers.
    accountModelOutcome(s, "defer", { kind: "deny", reason: "x" });
    // Two credits (real defer is a no-op, machinery is consecutive-only) →
    // consecutive = 1, total = 0.
    expect(s.trippedTier({ consecutive: 1, total: 200, verdict: "deny" })).toBeDefined();
    expect(s.trippedTier({ consecutive: 2, total: 200, verdict: "deny" })).toBeUndefined();
    expect(s.trippedTier({ consecutive: 999, total: 1, verdict: "deny" })).toBeUndefined();
  });

  it("strict's model-defer→deny counts as a deny-equivalent into the recoverable tier only", () => {
    const s = new CircuitBreaker();
    const tripAtOne = { consecutive: 1, total: 20, verdict: "deny" as const };
    accountModelOutcome(s, "defer", { kind: "deny", reason: "clarification" });
    // A wavering reviewer under strict is a denial stream — consecutive
    // fills (recoverable escape can fire), total stays model-denies-only.
    expect(s.trippedTier(tripAtOne)).toBeDefined();
    expect(s.trippedTier({ consecutive: 99, total: 1, verdict: "deny" })).toBeUndefined();
  });

  it("accountModelOutcome records real denies into both tiers regardless of the emitted mapping", () => {
    const s = new CircuitBreaker();
    // permissive maps a soft deny to allow — the recording keeps the model's deny.
    accountModelOutcome(s, "deny", { kind: "allow" });
    expect(s.trippedTier({ consecutive: 1, total: 20, verdict: "deny" })).toBeDefined();
    expect(s.trippedTier({ consecutive: 2, total: 1, verdict: "deny" })).toBeDefined();
  });
});
