import { describe, expect, it } from "vitest";

import { CircuitBreaker, VerdictCache } from "#src/session-state.ts";

const cb = { consecutive: 3, total: 20, verdict: "deny" as const };
const cc = { maxEntries: 3 };

const deny = { kind: "deny" as const, reason: "dangerous" };
const allow = { kind: "allow" as const };

describe("CircuitBreaker", () => {
  it("does not trip below the consecutive threshold", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(s.isTripped(cb)).toBe(false);
  });

  it("isTripped is a pure query — resetConsecutive is the separate, visible step", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(s.isTripped(cb)).toBe(true);
    // The pure query keeps reporting tripped until the caller resets.
    expect(s.isTripped(cb)).toBe(true);
    s.resetConsecutive();
    // Fresh consecutive window — next check won't trip until 3 more denies.
    expect(s.isTripped(cb)).toBe(false);
  });

  it("allow resets the consecutive counter", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    s.recordVerdict("allow");
    // allow broke the streak, so consecutive is 0 → not tripped
    expect(s.isTripped(cb)).toBe(false);
  });

  it("total is a permanent trip (resetConsecutive cannot clear it)", () => {
    const s = new CircuitBreaker();
    for (let i = 0; i < 20; i++) s.recordVerdict("deny");
    expect(s.isTripped(cb)).toBe(true);
    // total stays at 20; the reset is moot on the hard tier — still tripped.
    s.resetConsecutive();
    expect(s.isTripped(cb)).toBe(true);
  });

  it("does not count a breaker short-circuit or cache hit (caller responsibility)", () => {
    // The breaker only counts model verdicts via recordVerdict. If the caller
    // short-circuits (breaker trip or cache hit) without calling recordVerdict,
    // totals don't move. This is the no-double-count invariant.
    const s = new CircuitBreaker();
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    s.recordVerdict("deny");
    expect(s.isTripped(cb)).toBe(true); // trip → total still 3
    s.resetConsecutive();
    expect(s.isTripped(cb)).toBe(false); // consecutive 0, total 3 < 20
  });

  it("defer does not change counters", () => {
    const s = new CircuitBreaker();
    s.recordVerdict("defer");
    s.recordVerdict("defer");
    s.recordVerdict("defer");
    expect(s.isTripped(cb)).toBe(false);
  });
});

describe("VerdictCache", () => {
  it("returns disabled miss when maxEntries is 0", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    expect(s.lookup("cmd1", "ctx1", { maxEntries: 0 })).toEqual({
      hit: false,
      missReason: "disabled",
    });
  });

  it("stores and looks up a verdict", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({ hit: true, verdict: { kind: "allow" } });
  });

  it("misses with context-changed when contextHash differs", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    expect(s.lookup("cmd1", "ctx2", cc)).toEqual({
      hit: false,
      missReason: "context-changed",
    });
  });

  it("misses with no-entry when commandHash differs", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    expect(s.lookup("cmd2", "ctx1", cc)).toEqual({ hit: false, missReason: "no-entry" });
  });

  it("evicts the least-recently-used entry when full", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc); // capacity 3
    s.store("cmd2", "ctx2", { verdict: deny }, cc);
    s.store("cmd3", "ctx3", { verdict: allow }, cc);
    // Inserting a 4th evicts cmd1 (oldest)
    s.store("cmd4", "ctx4", { verdict: allow }, cc);
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({ hit: false, missReason: "no-entry" });
    expect(s.lookup("cmd4", "ctx4", cc)).toEqual({ hit: true, verdict: { kind: "allow" } });
  });

  it("LRU refresh on lookup moves entry to end", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    s.store("cmd2", "ctx2", { verdict: deny }, cc);
    s.store("cmd3", "ctx3", { verdict: allow }, cc);
    // Lookup cmd1 → refreshes it to most-recently-used
    s.lookup("cmd1", "ctx1", cc);
    // Now cmd2 is the oldest; inserting a 4th evicts cmd2, not cmd1
    s.store("cmd4", "ctx4", { verdict: allow }, cc);
    expect(s.lookup("cmd2", "ctx2", cc)).toEqual({ hit: false, missReason: "no-entry" });
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({ hit: true, verdict: { kind: "allow" } });
  });

  it("store on existing key refreshes LRU position", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    s.store("cmd2", "ctx2", { verdict: deny }, cc);
    s.store("cmd3", "ctx3", { verdict: allow }, cc);
    // Re-store cmd1 (update) → moves it to end
    s.store("cmd1", "ctx1", { verdict: deny }, cc);
    // Now cmd2 is oldest; inserting 4th evicts cmd2
    s.store("cmd4", "ctx4", { verdict: allow }, cc);
    expect(s.lookup("cmd2", "ctx2", cc)).toEqual({ hit: false, missReason: "no-entry" });
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({ hit: true, verdict: deny });
  });

  it("caches deny verdicts too (caller decides what to store)", () => {
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: deny }, cc);
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({
      hit: true,
      verdict: { kind: "deny", reason: "dangerous" },
    });
  });

  it("store overwrites the contextHash: stale-context lookup misses (safe)", () => {
    // Cache is keyed by command only, holding the LATEST context's verdict.
    // Storing the same command under a new context overwrites — so a lookup
    // with the old context misses and the caller re-runs the model (safe).
    const s = new VerdictCache();
    s.store("cmd1", "ctx1", { verdict: allow }, cc);
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({ hit: true, verdict: { kind: "allow" } });
    // Same command, new context → store overwrites
    s.store("cmd1", "ctx2", { verdict: deny }, cc);
    // Old context now misses (stale)
    expect(s.lookup("cmd1", "ctx1", cc)).toEqual({ hit: false, missReason: "context-changed" });
    // New context hits
    expect(s.lookup("cmd1", "ctx2", cc)).toEqual({
      hit: true,
      verdict: { kind: "deny", reason: "dangerous" },
    });
  });
});
