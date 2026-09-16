import { describe, expect, it } from "vitest";

import { createBoundedFifoMap, createBoundedMap } from "#src/core/bounded-map.ts";

describe("createBoundedMap (two-generation LRU)", () => {
  it("evicts past the capacity (a generation flip retires the young side)", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    map.set("c", 3); // flip: {a, b} is now the old generation
    expect(map.get("a")).toBe(1); // an old-generation hit is promoted
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(3); // still bounded: the next flip caps it
    map.set("d", 4); // flip again: {c, promoted} survives, "a"/"b" retire
    expect(map.size).toBeLessThanOrEqual(4);
    expect(map.get("c")).toBe(3);
    expect(map.get("d")).toBe(4);
  });

  it("a repeated read keeps an entry alive across a flip (the recency signal)", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1); // promote a to the fresh young generation
    map.set("c", 3); // flip: {a} young, {b} old
    map.set("d", 4); // flip: {a, promoted...} — the hot key survives, b does not
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBeUndefined();
  });

  it("re-setting an existing key updates in place", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10);
    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBe(2);
  });

  it("delete removes from both generations", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3); // a,b now old
    map.delete("a");
    expect(map.get("a")).toBeUndefined();
    expect(map.size).toBe(2);
  });

  it("draining a generation keeps the map within the capacity bound (regression)", () => {
    // The promotion inside get() must obey the same flip the set path
    // obeys. Reading the whole old generation out before touching the
    // young side used to walk promoted entries in past the cap — the sum
    // grew one entry per drain cycle, unbounded.
    const map = createBoundedMap<number, number>(2);
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      map.set(i, i);
      seen.push(i);
      for (const k of seen) map.get(k); // drain every previous entry
      expect(map.size).toBeLessThanOrEqual(3); // 2·cap − 1
    }
    // The bound also holds for a FIFO map with its exact eviction.
    const fifo = createBoundedFifoMap<number, number>(2);
    for (let i = 0; i < 200; i++) {
      fifo.set(i, i);
      for (const k of seen) fifo.get(k);
      expect(fifo.size).toBeLessThanOrEqual(2);
    }
  });

  it("clear empties the map", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.get("a")).toBeUndefined();
  });
});

describe("createBoundedFifoMap", () => {
  it("evicts the oldest entry past the capacity", () => {
    const map = createBoundedFifoMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    map.set("c", 3);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBeUndefined(); // oldest in, oldest out
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("reads do not affect survival (no recency to track)", () => {
    const map = createBoundedFifoMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1); // a read changes nothing
    map.set("c", 3);
    expect(map.get("a")).toBeUndefined(); // evicted anyway
  });

  it("re-setting an existing key updates in place without evicting", () => {
    const map = createBoundedFifoMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBe(2);
  });

  it("clear empties the map", () => {
    const map = createBoundedFifoMap<string, number>(2);
    map.set("a", 1);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.get("a")).toBeUndefined();
  });
});
