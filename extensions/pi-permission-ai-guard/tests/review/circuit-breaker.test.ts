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

  it("counts each real verdict once, reaching the total tier at exactly 20", () => {
    // The total has no reader, so it is pinned through the trip point: exactly
    // 17 further denies must be what reaches the hard tier of 20 — one phantom
    // increment would trip it on the 16th (the consecutive counter is reset
    // each round so only the total can be what trips).
    const s = new CircuitBreaker();
    for (let i = 0; i < 3; i++) s.recordVerdict("deny");
    expect(s.trippedTier(cb)).toBeDefined();
    s.resetConsecutive();
    for (let i = 0; i < 16; i++) {
      s.recordVerdict("deny");
      s.resetConsecutive();
    }
    expect(s.trippedTier(cb)).toBeUndefined();
    s.recordVerdict("deny");
    expect(s.trippedTier(cb)).toBeDefined();
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

  it("accountModelOutcome records real denies into both tiers regardless of the emitted mapping", () => {
    const s = new CircuitBreaker();
    // permissive maps a soft deny to allow — the recording keeps the model's deny.
    accountModelOutcome(s, "deny", { kind: "allow" });
    expect(s.trippedTier({ consecutive: 1, total: 20, verdict: "deny" })).toBeDefined();
    expect(s.trippedTier({ consecutive: 2, total: 1, verdict: "deny" })).toBeDefined();
  });
});
