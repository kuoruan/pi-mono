import { describe, expect, it } from "vitest";

import { VerdictCache } from "#src/review/verdict-cache.ts";

const cc = { maxEntries: 3 };

const deny = { kind: "deny" as const, reason: "dangerous" };
const allow = { kind: "allow" as const };
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
