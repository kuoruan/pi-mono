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

import type { AiGuardConfig, BreakerVerdict, Mode, NotifyThreshold } from "./config-schema.ts";
import type { RiskLevel } from "./model-verdict.ts";

/**
 * Session-scoped runtime overrides over the config file. Set via the
 * `/ai-guard` command or the `ctrl+alt+g` shortcut; each change is appended
 * to the pi session file (custom entry, never LLM context) and restored on
 * resume. A new session starts from the config values.
 *
 * Invariant: an override key PRESENT means it carries a defined value.
 * Writers delete on undefined (the settings surface does); readers treat
 * "absent" and "undefined" as the same. This keeps the save snapshot
 * projection ({@link effectiveConfig}) from being shadowed by dead keys.
 */
export interface SessionOverrides {
  /** Guard mode for this session; undefined = use the config's mode. */
  mode?: Mode;
  /** Ambient-notify threshold for this session; undefined = config value. */
  notifyLevel?: NotifyThreshold;
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
   * Pure query: would the breaker trip on the next verdict? No counters
   * mutate — the trip's reset is a separate, deliberately visible step
   * ({@link resetConsecutive}), never hidden inside a boolean condition.
   *
   * @param cb - The circuit-breaker thresholds to check against.
   * @returns True if either tier is at its threshold.
   */
  isTripped(cb: CircuitBreakerConfig): boolean {
    return this.totalDenies >= cb.total || this.consecutiveDenies >= cb.consecutive;
  }

  /**
   * Reset the recoverable consecutive tier. The pipeline calls it when a
   * trip was consumed, giving the model a fresh consecutive window. After a
   * hard-tier trip the reset is behaviorally moot (the total tier never
   * clears), but the call site stays uniform.
   */
  resetConsecutive(): void {
    this.consecutiveDenies = 0;
  }

  /**
   * Record a deny-EQUIVALENT — a denial the agent experienced although the
   * model never pronounced one: machinery failures denied by the strict /
   * permissive lanes (the reviewer could not even produce a verdict), and
   * strict's model-defer→deny mapping (a wavering reviewer becomes a
   * denial stream). Deny-equivalents credit the RECOVERABLE tier only, so
   * a broken or persistently uncertain reviewer can trip the
   * consecutive-denial trip like a miscalibrated one. The `total` hard cap
   * stays model-denies-only: an equivalent storm must not permanently trip
   * a session.
   */
  recordDenyEquivalent(): void {
    this.consecutiveDenies++;
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

/**
 * The breaker gate's accounting step: consume a trip — one visible call
 * combining the pure query and the explicit recoverable-tier reset, so
 * the side effect stays at this single point instead of being split
 * across the pipeline's condition and its body.
 *
 * @param breaker - The session breaker.
 * @param cb - The thresholds.
 * @returns True when the trip fired (the caller short-circuits the ask).
 */
export function consumeTrip(breaker: CircuitBreaker, cb: CircuitBreakerConfig): boolean {
  if (!breaker.isTripped(cb)) {
    return false;
  }
  breaker.resetConsecutive();
  return true;
}

/**
 * The model lane's per-ask accounting step: record the model's real
 * verdict, then credit the recoverable tier when the emitted verdict was
 * a machinery denial — the reviewer never produced a verdict (strict and
 * permissive deny machinery; a broken reviewer must still be able to trip
 * the breaker like a miscalibrated one). The two-tier doctrine lives
 * beside the breaker: model denies feed both tiers, machinery failures
 * feed consecutive only, mapped verdicts don't change what was recorded.
 *
 * @param breaker - The session breaker.
 * @param original - The model's verdict kind.
 * @param emitted - The verdict the link emitted.
 */
export function accountModelOutcome(
  breaker: CircuitBreaker,
  original: AuthorizerVerdict["kind"],
  emitted: AuthorizerVerdict,
): void {
  breaker.recordVerdict(original);
  if (emitted.kind === "deny" && original === "defer") {
    // strict maps the model's own uncertainty to a deny as well as
    // machinery failures — both are deny-equivalents for the recoverable
    // tier (see recordDenyEquivalent).
    breaker.recordDenyEquivalent();
  }
}

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

/** The overridable config keys: name-matched fields of overrides and config. */
export type OverridableKey = keyof SessionOverrides & keyof AiGuardConfig;

/**
 * The "override beats config" rule, spelled once: the typed per-field
 * accessor every runtime reader of an overridable key routes through. A
 * new override field is compile-keyed here — a reader that forgets the
 * precedence stops type-checking instead of silently reading the config.
 * The full-snapshot projection ({@link effectiveConfig}) serves only the
 * save action.
 *
 * @param overrides - The stable session overrides object.
 * @param config - The validated config (required config yields a
 *   non-optional result).
 * @param key - The field to resolve.
 * @returns The effective field value.
 */
export function effectiveOverride<T extends OverridableKey>(
  overrides: SessionOverrides,
  config: AiGuardConfig,
  key: T,
): AiGuardConfig[T];
export function effectiveOverride<T extends OverridableKey>(
  overrides: SessionOverrides,
  config: AiGuardConfig | undefined,
  key: T,
): AiGuardConfig[T] | undefined;
export function effectiveOverride<T extends OverridableKey>(
  overrides: SessionOverrides,
  config: AiGuardConfig | undefined,
  key: T,
): AiGuardConfig[T] | undefined {
  // The indexed-access read is sound (both interfaces key the same field
  // name with the same value type) but TS cannot prove it across a generic
  // key once more than one field exists — cast on the single read seam.
  return (overrides[key] ?? config?.[key]) as AiGuardConfig[T] | undefined;
}

/**
 * The effective config: the loaded snapshot with every DEFINED override
 * applied — the save action's hole-snapshot projection (per-field reads
 * go through {@link effectiveOverride}).
 *
 * Keys whose override is undefined are skipped, so a reset (which deletes
 * the key) never lets a dead `mode: undefined` shadow the config value
 * into the saved layer file — the bug this projection exists to make
 * impossible.
 *
 * @param config - The validated loaded config.
 * @param overrides - The stable session overrides object.
 * @returns The materialized effective config. Values of override keys are
 *   runtime-validated upstream; legality for persistence is re-checked by
 *   the persist schema gate, not here.
 */
export function effectiveConfig(config: AiGuardConfig, overrides: SessionOverrides): AiGuardConfig {
  const result: Record<string, unknown> = { ...config };
  for (const key of Object.keys(overrides) as Array<keyof SessionOverrides>) {
    const value = overrides[key];
    if (value !== undefined) result[key] = value;
  }
  // The projection point carries the module's cast budget: SessionOverrides
  // keys are dynamic, so the rebuilt shape is re-asserted here, once.
  return result as AiGuardConfig;
}
