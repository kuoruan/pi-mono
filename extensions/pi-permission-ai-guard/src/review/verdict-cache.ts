/** The verdict cache — repeated identical asks skip the model call (see {@link VerdictCache}). */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { RiskLevel } from "#src/model/model-verdict.ts";

/** A cached verdict entry, keyed by commandHash. */
export interface CacheEntry {
  /** The verdict to return on a cache hit. */
  verdict: AuthorizerVerdict;
  /** Optional risk level from the model verdict. */
  riskLevel?: RiskLevel;
}

/** A cached entry as stored, keyed by commandHash. */
interface StoredEntry extends CacheEntry {
  /** The trusted-intent context the verdict applies to (invalidation key). */
  contextHash: string;
}

/** Verdict cache configuration. */
export interface CacheConfig {
  /** Max entries (LRU). 0 disables caching. */
  maxEntries: number;
}

/** Why a cache lookup missed. */
export type CacheMissReason =
  | "disabled" // cache.maxEntries is 0
  | "no-entry" // commandHash not in cache (first time or evicted)
  | "context-changed"; // commandHash exists but contextHash differs

/** Result of a cache lookup: either a hit with the verdict, or a miss reason. */
export type CacheLookupResult =
  | { hit: true; verdict: AuthorizerVerdict; riskLevel?: RiskLevel }
  | { hit: false; missReason: CacheMissReason };

/**
 * Verdict cache: LRU of recent (command, context) → verdict, so repeated
 * identical asks in a stable conversation skip the model call.
 */
export class VerdictCache {
  private cache = new Map<string, StoredEntry>();

  /**
   * Look up a cached verdict. Returns a hit only when both the command and
   * the trusted-intent context match (same command + moved conversation would
   * have a different contextHash and miss, which is the desired invalidation).
   * The miss reason lets callers emit telemetry distinguishing "first time"
   * from "context changed since last run".
   *
   * @param commandHash - Hash of the command being looked up.
   * @param contextHash - Hash of the current trusted-intent context.
   * @param cc - The cache configuration.
   * @returns A cache hit with the verdict, or a miss with the reason.
   */
  lookup(commandHash: string, contextHash: string, cc: CacheConfig): CacheLookupResult {
    if (cc.maxEntries <= 0) return { hit: false, missReason: "disabled" };
    const entry = this.cache.get(commandHash);
    if (!entry) return { hit: false, missReason: "no-entry" };
    if (entry.contextHash !== contextHash) {
      return { hit: false, missReason: "context-changed" };
    }
    // LRU refresh: move to end so the most-recently-used survives eviction.
    this.cache.delete(commandHash);
    this.cache.set(commandHash, entry);
    return { hit: true, verdict: entry.verdict, riskLevel: entry.riskLevel };
  }

  /**
   * Store a verdict. The cache is keyed by commandHash only and holds the
   * LATEST context's verdict — storing the same command under a new
   * contextHash overwrites the previous entry, so a lookup with the now-
   * stale context misses and the caller re-runs the model (safe: a miss
   * never returns a wrong verdict). When the cache is full, evict the
   * least-recently-used (the first key in insertion order). Updating an
   * existing key refreshes its LRU position via delete+set.
   *
   * @param commandHash - Hash of the command to store under.
   * @param contextHash - Hash of the trusted-intent context this verdict applies to.
   * @param entry - The cache entry (verdict + optional risk level) to store.
   * @param cc - The cache configuration.
   */
  store(commandHash: string, contextHash: string, entry: CacheEntry, cc: CacheConfig): void {
    if (cc.maxEntries <= 0) return;
    if (this.cache.has(commandHash)) {
      this.cache.delete(commandHash);
    } else if (this.cache.size >= cc.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(commandHash, { ...entry, contextHash });
  }
}
