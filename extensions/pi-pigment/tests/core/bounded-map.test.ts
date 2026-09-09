import { describe, expect, it } from "vitest";

import { createBoundedMap } from "#src/core/bounded-map.ts";

describe("createBoundedMap", () => {
  it("evicts the least-recently-used entry past the capacity", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    map.set("c", 3);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBeUndefined(); // oldest evicted
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("refreshes recency on get (a touched entry survives)", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1); // touch a: now b is the oldest
    map.set("c", 3);
    expect(map.get("a")).toBe(1); // survived
    expect(map.get("b")).toBeUndefined(); // evicted
  });

  it("re-setting an existing key updates in place and refreshes recency", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10); // refresh a, b oldest
    map.set("c", 3);
    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(3);
  });

  it("clear empties the map", () => {
    const map = createBoundedMap<string, number>(2);
    map.set("a", 1);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.get("a")).toBeUndefined();
  });
});
