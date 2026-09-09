/**
 * A capacity-bounded memo map — the single eviction implementation the
 * codebase's caches share (highlight blocks, theme memos, pattern
 * matchers, thrown spans). Semantics: least-recently-used eviction — a
 * `get` refreshes recency, `set` inserts at the most-recent position and
 * evicts past the capacity. (The hand-rolled bounds this replaces were
 * FIFO on four of five sites; the change only ever affects WHICH cached
 * entry survives, never correctness — a miss re-derives the value.)
 */

/**
 * Build a bounded map.
 *
 * @param capacity - The maximum number of entries (insertion past it
 *   evicts the least-recently-used entry).
 * @returns A Map-like object with LRU eviction on set/get.
 */
export function createBoundedMap<K, V>(capacity: number): BoundedMap<K, V> {
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      if (!map.has(key)) return undefined;
      // LRU touch: delete+re-insert moves the entry to the most-recent
      // position (Map preserves insertion order).
      const value = map.get(key) as V;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: K, value: V): void {
      map.delete(key);
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

/** The bounded map's interface (minimal — the caches need nothing else). */
export interface BoundedMap<K, V> {
  /** Reads the value (refreshing its recency). */
  get(key: K): V | undefined;
  /** Writes the value (evicting the least-recently-used past capacity). */
  set(key: K, value: V): void;
  /** Removes the entry (the read-once consumers' path). */
  delete(key: K): void;
  /** The current entry count. */
  readonly size: number;
  /** Clears every entry (the test isolation path). */
  clear(): void;
}
