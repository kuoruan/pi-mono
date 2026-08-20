/**
 * Per-session state for the ai-guard chain link.
 *
 * 1. {@link CircuitBreaker} — consecutive/total deny counters. `consecutive` is a recoverable tier
 *    (resets on trip so the model gets another chance); `total` is a hard session cap (never
 *    resets). Each consecutive trip also bumps `total`, so repeated abuse walks toward the
 *    permanent trip.
 * 2. {@link VerdictCache} — LRU of recent (command, context) → verdict, so repeated identical asks in
 *    a stable conversation skip the model call.
 * 3. {@link SessionOverrides} — the runtime-settings contract: a stable overrides object (allocated
 *    once per extension instance by the SessionLifecycle, reset in place per session) whose
 *    optional fields shadow their same-named config fields.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { BreakerVerdict, Mode } from "./config-schema.ts";
import type { RiskLevel } from "./verdict.ts";

/**
 * Session-scoped runtime overrides over the config file. Set via the
 * `/ai-guard` command or the `ctrl+alt+g` shortcut; each change is appended
 * to the pi session file (custom entry, never LLM context) and restored on
 * resume. A new session starts from the config values.
 */
export interface SessionOverrides {
  /** Guard mode for this session; undefined = use the config's mode. */
  mode?: Mode;
}

/** A cached verdict entry, keyed by commandHash. */
export interface CacheEntry {
  /** The verdict to return on a cache hit. */
  verdict: AuthorizerVerdict;
  /** Optional risk level from the model verdict. */
  riskLevel?: RiskLevel;
}

/** Circuit breaker thresholds. */
export interface CircuitBreakerConfig {
  /** Recoverable tier: trip after this many consecutive denies (resets on trip). */
  consecutive: number;
  /** Hard session cap: trip after this many total denies (never resets). */
  total: number;
  /** Verdict to return when the breaker trips. */
  verdict: BreakerVerdict;
}

/** Verdict cache configuration. */
export interface CacheConfig {
  /** Max entries (LRU). 0 disables caching. */
  maxEntries: number;
}

/**
 * Circuit breaker: trips after too many deny verdicts in one session.
 *
 * `consecutive` is a recoverable tier (resets on trip so the model gets
 * another chance); `total` is a hard session cap (never resets, so once
 * tripped it stays tripped).
 */
export class CircuitBreaker {
  private consecutiveDenies = 0;
  private totalDenies = 0;

  /**
   * Check whether the breaker should trip. If it does, reset the
   * consecutive counter (recoverable tier) so the model gets another chance
   * on the next ask; `total` is never reset (hard tier).
   *
   * The reset side-effect is intentional and named in the method to make it
   * obvious — callers must not assume this is a pure query.
   *
   * @param cb - The circuit-breaker thresholds to check against.
   * @returns True if the breaker tripped (and the consecutive counter was reset if it was the
   *   recoverable tier).
   */
  checkAndResetIfTripped(cb: CircuitBreakerConfig): boolean {
    if (this.totalDenies >= cb.total) {
      return true; // permanent (hard tier): total never resets
    }
    if (this.consecutiveDenies >= cb.consecutive) {
      this.consecutiveDenies = 0; // recoverable tier: give the model another chance
      return true;
    }
    return false;
  }

  /**
   * Record a model-produced verdict into the breaker counters.
   * Only call this for genuine model verdicts (not cache hits or breaker
   * short-circuits) — otherwise counts would double and the breaker would
   * trip on cached/short-circuited results too.
   *
   * - Deny → consecutive++ and total++
   * - Allow → consecutive = 0 (any allow breaks a denial streak)
   * - Defer → no change (uncertain verdicts don't count either way)
   *
   * @param kind - The model-produced verdict kind to record.
   */
  recordVerdict(kind: AuthorizerVerdict["kind"]): void {
    if (kind === "deny") {
      this.consecutiveDenies++;
      this.totalDenies++;
    } else if (kind === "allow") {
      this.consecutiveDenies = 0;
    }
    // defer: no-op
  }
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
  private cache = new Map<string, CacheEntry & { contextHash: string }>();

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
