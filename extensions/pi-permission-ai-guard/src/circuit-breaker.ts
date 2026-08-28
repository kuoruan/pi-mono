/** The circuit breaker — the session's deny-tier accounting (see {@link CircuitBreaker}). */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { BreakerVerdict } from "./config-schema.ts";

/** Which tier is tripped: the hard session cap or the recoverable streak. */
export type BreakerTier = "total" | "consecutive";

/** Circuit breaker thresholds. */
export interface CircuitBreakerConfig {
  /** Recoverable tier: trip after this many consecutive denies (resets on trip). */
  consecutive: number;
  /** Hard session cap: trip after this many total denies (never resets on its own). */
  total: number;
  /** Verdict to return when the breaker trips. */
  verdict: BreakerVerdict;
}

/**
 * Circuit breaker: trips after too many deny verdicts in one session.
 *
 * `consecutive` is a recoverable tier (resets on trip so the model gets
 * another chance); `total` is a hard session cap (never resets on its own —
 * only resetAll or a fresh session clears it).
 */
export class CircuitBreaker {
  private consecutiveDenies = 0;
  private totalDenies = 0;
  private totalTripNoticeClaimed = false;

  /**
   * Pure query: would the breaker trip on the next verdict? No counters
   * mutate — the trip's reset is a separate, deliberately visible step
   * ({@link resetConsecutive}), never hidden inside a boolean condition.
   *
   * @param cb - The circuit-breaker thresholds to check against.
   * @returns True if either tier is at its threshold.
   */
  isTripped(cb: CircuitBreakerConfig): boolean {
    return this.trippedTier(cb) !== undefined;
  }

  /**
   * Pure query: WHICH tier is tripped — the hard session cap takes
   * precedence (both at threshold means the persistent state is the one
   * the operator must hear about).
   *
   * @param cb - The circuit-breaker thresholds to check against.
   * @returns `"total"` or `"consecutive"` when tripped, else undefined.
   */
  trippedTier(cb: CircuitBreakerConfig): BreakerTier | undefined {
    if (this.totalDenies >= cb.total) return "total";
    if (this.consecutiveDenies >= cb.consecutive) return "consecutive";
    return undefined;
  }

  /**
   * Claim the one-time total-tier trip notice: true exactly once per
   * total-trip epoch ({@link resetAll} re-arms it), so a persistent trip
   * notifies once instead of on every ask.
   *
   * @returns True when the caller owes the operator the notice.
   */
  claimTotalTripNotice(): boolean {
    if (this.totalTripNoticeClaimed) return false;
    this.totalTripNoticeClaimed = true;
    return true;
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
   * Manual full reset (`/ai-guard breaker reset`): both tiers to zero and
   * the total-trip notice re-armed. Pure in-memory counter mutation — no
   * persistence, no session-file interaction; resume builds a fresh
   * breaker either way (a new session gets fresh state regardless of any
   * prior manual reset).
   *
   * Reports which tier was tripped at the moment of the reset — one call
   * instead of a query-then-mutate pair (the same single-call doctrine as
   * {@link consumeTrip}), so the caller's copy ("was total-tier tripped")
   * reads a result, never a pre-state it must query first.
   *
   * @param cb - The circuit-breaker thresholds (the tier report is
   *   threshold-dependent).
   * @returns The tier that was tripped, or undefined when the breaker was
   * already clear.
   */
  resetAll(cb: CircuitBreakerConfig): BreakerTier | undefined {
    const tier = this.trippedTier(cb);
    this.consecutiveDenies = 0;
    this.totalDenies = 0;
    this.totalTripNoticeClaimed = false;
    return tier;
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
 * The result of {@link consumeTrip}: which tier tripped, and whether the
 * one-time total-tier operator notice is due.
 */
export type TripResult =
  | { tripped: false }
  | { tripped: true; tier: BreakerTier; totalNoticeDue: boolean };

/**
 * The breaker gate's accounting step: consume a trip — one visible call
 * combining the pure query and the explicit recoverable-tier reset, so
 * the side effect stays at this single point instead of being split
 * across the pipeline's condition and its body. The discriminated result
 * tells the caller WHICH tier tripped and whether the one-time total-tier
 * operator notice is due (set once per total-trip epoch — cleared by a
 * reset — so a persistent trip notifies once, not on every ask).
 *
 * @param breaker - The session breaker.
 * @param cb - The thresholds.
 * @returns The trip result: tier + notice-due when tripped, or
 *   `{ tripped: false }` when the breaker lets the ask through.
 */
export function consumeTrip(breaker: CircuitBreaker, cb: CircuitBreakerConfig): TripResult {
  const tier = breaker.trippedTier(cb);
  if (!tier) {
    return { tripped: false };
  }
  breaker.resetConsecutive();
  const totalNoticeDue = tier === "total" && breaker.claimTotalTripNotice();
  return { tripped: true, tier, totalNoticeDue };
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
