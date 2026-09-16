/**
 * Capacity-bounded memo maps — the single eviction implementations the
 * codebase's caches share (highlight blocks, theme memos, pattern
 * matchers, thrown spans, line-verdict memos). Neither policy's eviction
 * order is ever a correctness concern: a miss re-derives the value.
 *
 * Both get their shape from what the community ships for JS caches:
 * `createBoundedMap` is the two-generation scheme of quick-lru (itself
 * hashlru's algorithm) — the standard "fast LRU", because a hit in the
 * young generation costs one plain `Map.get` (measured ~13ns against
 * ~60ns for the delete+re-insert recency touch on the same key set).
 * `createBoundedFifoMap` is exact FIFO for verdict-style memos whose
 * entries are pure functions of the key: recency carries no information,
 * so the read is the same single `Map.get` and the oldest entry simply
 * leaves first.
 */

/**
 * Build a bounded memo map with two-generation (approximate LRU) eviction.
 *
 * Reads hit one of two maps: the young generation (one plain `Map.get`,
 * no reordering) or the old one (promoted: removed from old, inserted
 * into young — that promotion is the recency signal). Writing past the
 * capacity retires the young generation wholesale (it becomes the old
 * one and a fresh young opens), so the worst-case footprint is twice
 * the capacity and eviction is amortized O(1) — no per-entry free list,
 * no pointer relinking.
 *
 * The flip check guards BOTH insertion paths: `set` at the cap, and the
 * promotion inside `get`. Without the latter, draining a just-retired
 * generation (reading every old entry before touching the young side)
 * walks promoted entries into the young map past the cap — the sum
 * grows one entry per drain cycle, unbounded (a capacity-2 map reached
 * 12 entries in exactly that pattern). With it, the sum stays within
 * 2·capacity − 1: a flip drops the older generation before anything
 * enters the fresh young side.
 *
 * @param capacity - The size that triggers a generation flip (the map
 *   holds at most twice this many entries).
 * @returns A Map-like object with two-generation eviction on set/get.
 */
export function createBoundedMap<K, V>(capacity: number): BoundedMap<K, V> {
  let young = new Map<K, V>();
  let old = new Map<K, V>();
  /** Retire the young generation once it reaches the capacity. */
  const flipAtCapacity = (): void => {
    if (young.size >= capacity) {
      old = young;
      young = new Map();
    }
  };
  return {
    get(key: K): V | undefined {
      const fresh = young.get(key);
      if (fresh !== undefined) return fresh;
      const stale = old.get(key);
      if (stale === undefined) return undefined;
      // Promote: the old generation's hit is the recency signal. The
      // insertion obeys the same flip the set path obeys — draining the
      // previous generation must not walk the young side past the cap.
      flipAtCapacity();
      old.delete(key);
      young.set(key, stale);
      return stale;
    },
    set(key: K, value: V): void {
      young.set(key, value);
      flipAtCapacity();
    },
    delete(key: K): void {
      young.delete(key);
      old.delete(key);
    },
    get size(): number {
      // A key can sit in both generations briefly (written again after a
      // flip without a read in between); count it once.
      let total = young.size;
      for (const key of old.keys()) if (!young.has(key)) total++;
      return total;
    },
    clear(): void {
      young.clear();
      old.clear();
    },
  };
}

/**
 * Build a bounded memo map with exact FIFO eviction: a read is one plain
 * `Map.get` (recency is not tracked at all), and the oldest entry leaves
 * first past the capacity. The fit for verdict-style memos — values that
 * are a pure function of the key (a line's cluster-gate verdict), where
 * recency carries no information and the only questions are hit or miss.
 *
 * @param capacity - The maximum number of entries (insertion past it
 *   evicts the oldest entry).
 * @returns A Map-like object with FIFO eviction on set.
 */
export function createBoundedFifoMap<K, V>(capacity: number): BoundedMap<K, V> {
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      return map.get(key);
    },
    set(key: K, value: V): void {
      map.set(key, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(key: K): void {
      map.delete(key);
    },
    get size(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
  };
}

/** The bounded memo map's interface — the caches need nothing else. */
export interface BoundedMap<K, V> {
  /** Reads the value (and registers the read for the factory's policy). */
  get(key: K): V | undefined;
  /** Writes the value (evicting by the factory's policy past the capacity). */
  set(key: K, value: V): void;
  /** Removes the entry (the read-once consumers' path). */
  delete(key: K): void;
  /** The current entry count. */
  readonly size: number;
  /** Clears every entry (the test isolation path). */
  clear(): void;
}
