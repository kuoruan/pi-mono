/**
 * ReviewerPool: one ordered failover loop over heterogeneous reviewer
 * endpoints (LLM registry models and Jev System One endpoints, in any
 * order). Per-lane adapters translate backend failures into the
 * three-state {@link AttemptResult}; the pool only pattern-matches the
 * three states — it never interprets a backend error itself.
 *
 * Failover, not second opinion: a valid verdict (allow/deny/defer) is
 * terminal on the endpoint that produced it. Only an unanswered backend
 * (availability failure) advances to the next endpoint. Auth/access
 * refusals are terminal by construction (adapters report them as
 * `terminal`, never `retryable`).
 */

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import type { AvailabilityReason } from "#src/model/model-verdict.ts";
import {
  type EngineCallContext,
  type EngineMachineryFailure,
  type EngineReviewResult,
  isMachineryFailure as isMachinery,
} from "#src/review/reviewer-engine.ts";

/**
 * One attempt's disposition, as reported by a lane adapter:
 *
 * - `answered`: the backend produced a verdict — terminal, whoever it is.
 * - `retryable`: the backend could not serve the request (availability failure) — the pool advances
 *   when another endpoint remains, otherwise it invokes `finalize` for the terminal record. The raw
 *   error never leaves the adapter: `finalize` owns the terminal defer/machinery outcome, including
 *   the debug-stream emission.
 * - `terminal`: the backend refused or failed finally (auth failure, malformed request) — no
 *   failover, the result ships as-is.
 *
 * Every variant carries the endpoint's audit identity (`modelId` — inside
 * `result` for answered/terminal, top-level for retryable), so the pool
 * never formats a lane-specific identity itself.
 */
export type AttemptResult =
  | { kind: "answered"; result: EngineReviewResult }
  | {
      kind: "retryable";
      modelId: string;
      reason: AvailabilityReason;
      finalize: () => EngineReviewResult | EngineMachineryFailure;
    }
  | { kind: "terminal"; result: EngineReviewResult | EngineMachineryFailure };

/** One LLM endpoint in the ordered failover list (registry-resolved). */
export interface LlmPoolEndpoint {
  lane: "llm";
  provider: string;
  model: string;
  timeoutMs: number;
}

/** One Jev endpoint in the ordered failover list (explicitly authenticated). */
export interface JevPoolEndpoint {
  lane: "jev";
  provider: { type: "typesafe"; baseUrl?: string; apiKey?: string };
  model: string;
  timeoutMs: number;
}

/** One endpoint in the ordered failover list (pure data — lane dispatch is the adapter's). */
export type PoolEndpoint = LlmPoolEndpoint | JevPoolEndpoint;

/** The lane discriminant shared by endpoints and adapters. */
export type PoolLane = PoolEndpoint["lane"];

/**
 * Stamp a shipped result: backup verdicts never cache (the primary gets
 * another chance next ask); machinery never caches (no verdict at all).
 *
 * @param result - The result to ship.
 * @param index - The endpoint position (0 = primary, keeps its default).
 * @returns The result, marked uncached when it came from a backup.
 */
function ship(
  result: EngineReviewResult | EngineMachineryFailure,
  index: number,
): EngineReviewResult | EngineMachineryFailure {
  return !isMachinery(result) && index > 0 ? { ...result, cacheable: false } : result;
}

/** Per-attempt instructions from the pool: position, retry mode, budget. */
export interface AttemptSpec {
  /** The endpoint's position (0 = primary; >0 marks the verdict uncached). */
  index: number;
  /** True when this is the only endpoint (preserves legacy retry behavior). */
  singleEndpoint: boolean;
  /**
   * The attempt budget: the endpoint's own `timeoutMs` trimmed against
   * the remaining walk budget, never extended.
   */
  timeoutMs: number;
}

/** A lane adapter: attempt one endpoint, report the three-state disposition. */
export interface LaneAdapter {
  /**
   * Attempt one review on the given endpoint.
   *
   * @param endpoint - The endpoint to try (matches this adapter's lane;
   *   stays read-only — the walk budget arrives via `spec`).
   * @param ctx - The engine call context.
   * @param spec - Position, retry mode, and budget for this attempt.
   */
  attempt(
    endpoint: PoolEndpoint,
    ctx: EngineCallContext,
    spec: AttemptSpec,
  ): Promise<AttemptResult>;
}

/**
 * Floor for attempting another endpoint: below this remaining budget the
 * pool stops the walk and finalizes the last failure instead of firing a
 * request doomed to be cut off.
 */
export const WALK_BUDGET_FLOOR_MS = 2_000;

/**
 * Default fallback timeout: matches the proxy-wide convention (LiteLLM
 * `request_timeout` defaults to 10s-class per-attempt budgets) — a slow
 * primary failing over to an equally slow backup doubles the worst case
 * for no reason. Explicit entries win.
 */
export const FALLBACK_TIMEOUT_DEFAULT_MS = 10_000;

export interface ReviewerPoolDeps {
  /** Ordered endpoints: primary first, backups after (at least one). */
  endpoints: PoolEndpoint[];
  /** Lane adapters, keyed by lane. */
  adapters: Record<PoolLane, LaneAdapter>;
  /**
   * Walk budget ceiling: the whole ordered walk never waits longer than
   * this (default `2 × primary timeout`, floored at 30s so one slow
   * primary cannot starve every backup). Per-endpoint `timeoutMs` stays
   * the cap for that endpoint; the budget only trims it.
   */
  walkBudgetMs?: number;
  /** Injected clock (tests only). */
  now?: () => number;
}

/**
 * Settle one walk outcome: backup verdicts never cache and the latency
 * covers the whole walk (failover cost stays visible).
 *
 * @param terminal - The terminal record.
 * @param index - The endpoint's position.
 * @param startedAt - The walk start (wall-clock latency covers the walk).
 * @param now - The clock.
 * @returns The settled record.
 */
function settleWalk(
  terminal: EngineReviewResult | EngineMachineryFailure,
  index: number,
  startedAt: number,
  now: () => number,
): EngineReviewResult | EngineMachineryFailure {
  if (isMachinery(terminal)) return terminal;
  return ship(
    { ...terminal, outcome: { ...terminal.outcome, latencyMs: now() - startedAt } },
    index,
  );
}

/**
 * Create the pooled reviewer engine: one loop over heterogeneous
 * endpoints, satisfying the `ReviewerEngine` seam so the pipeline stays
 * lane-blind.
 *
 * @param deps - The ordered endpoints and lane adapters.
 * @returns A `ReviewerEngine` whose review walks the endpoint list.
 */
export function createReviewerPool(deps: ReviewerPoolDeps): {
  review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure>;
} {
  const { endpoints, adapters } = deps;
  const now = deps.now ?? Date.now;
  const primary = endpoints[0];
  if (!primary) throw new Error("createReviewerPool requires at least one endpoint");
  const walkBudgetMs = deps.walkBudgetMs ?? Math.max(2 * primary.timeoutMs, 30_000);

  return {
    async review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure> {
      const startedAt = now();
      const deadline = startedAt + walkBudgetMs;
      // Per-walk state only: concurrent reviews never share it.
      let lastRetryable: Extract<AttemptResult, { kind: "retryable" }> | undefined;
      const settle = (
        terminal: EngineReviewResult | EngineMachineryFailure,
        index: number,
      ): EngineReviewResult | EngineMachineryFailure => settleWalk(terminal, index, startedAt, now);
      for (const [index, endpoint] of endpoints.entries()) {
        const remaining = deadline - now();
        // Below the floor no useful attempt fits: finalize the last
        // failure instead of firing a request doomed to be cut off.
        // Index 0 always runs (nothing to finalize yet). The remaining
        // budget never extends an endpoint's own timeout.
        if (lastRetryable && remaining < WALK_BUDGET_FLOOR_MS)
          return settle(lastRetryable.finalize(), index);
        const attempt = await adapters[endpoint.lane].attempt(endpoint, ctx, {
          index,
          singleEndpoint: endpoints.length === 1,
          timeoutMs: Math.min(endpoint.timeoutMs, Math.max(remaining, 0)),
        });
        if (attempt.kind !== "retryable") return settle(attempt.result, index);
        lastRetryable = attempt;
        // Retryable on the last endpoint: it owns the terminal record
        // (debug emission included) — no further hop to audit.
        if (index + 1 >= endpoints.length) return settle(attempt.finalize(), index);
        // The hop is audited only when the next endpoint actually runs:
        // a floor-stop below finalizes without contacting it.
        if (deadline - now() >= WALK_BUDGET_FLOOR_MS) {
          // No URL, credential or upstream error body enters the review log.
          ctx.log.review(FALLBACK_EVENT, {
            requestId: ctx.requestId,
            failedEndpoint: index,
            nextEndpoint: index + 1,
            modelId: attempt.modelId,
            reason: attempt.reason,
          });
        }
      }
      // The primary endpoint is always present, so the loop always returns.
      throw new Error("unreachable: no reviewer endpoints");
    },
  };
}
