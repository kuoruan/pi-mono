/**
 * ReviewerPool: one ordered failover loop over heterogeneous reviewer
 * endpoints (chat registry models and classifier System One endpoints, in any
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
  type EngineAttemptResult,
  type EngineCallContext,
  type EngineReviewResult,
  type ReviewerEngine,
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
 * A shipped result carries the endpoint's audit identity in its own
 * `modelId`; the pool stamps the walk position onto it when it ships (see
 * {@link settleWalk}), so an adapter never formats a position itself.
 */
export type AttemptResult =
  | { kind: "answered"; result: EngineReviewResult }
  | {
      kind: "retryable";
      reason: AvailabilityReason;
      finalize: () => EngineAttemptResult;
    }
  | { kind: "terminal"; result: EngineAttemptResult };

/** One chat endpoint in the ordered failover list (registry-resolved). */
export interface ChatPoolEndpoint {
  lane: "chat";
  /** A registry model-provider id (never a connection object). */
  provider: string;
  model: string;
  timeoutMs: number;
  /** The resolved sampling temperature; `undefined` leaves the field off the wire. */
  temperature: number | undefined;
  /**
   * The endpoint's bare audit identity (`provider/model`), built where the
   * endpoint is. The pool appends the walk position.
   */
  id: string;
}

/** A classifier endpoint's provider: explicit connection, env-backed when unset. */
export interface ClassifierProvider {
  type: "typesafe";
  baseUrl?: string;
  apiKey?: string;
}

/** One classifier endpoint in the ordered failover list. */
export type ClassifierPoolEndpoint =
  | {
      lane: "classifier";
      /** Explicit connection, env-backed when unset. */
      backend: "direct";
      provider: ClassifierProvider;
      model: string;
      timeoutMs: number;
      /** The endpoint's bare audit identity (the SDK protocol prefix: `typesafe/<model>`). */
      id: string;
    }
  | {
      lane: "classifier";
      /** Pi's built-in classifier, resolved through the model registry. */
      backend: "registry";
      provider: string;
      model: string;
      timeoutMs: number;
      /** The endpoint's bare audit identity (Pi's provider id: `<provider>/<model>`). */
      id: string;
    };

/** The registry classifier endpoint: pi resolves the model, so `provider` is a name. */
export type ClassifierRegistryEndpoint = Extract<ClassifierPoolEndpoint, { backend: "registry" }>;

/** One endpoint in the ordered failover list (pure data — lane dispatch is the adapter's). */
export type PoolEndpoint = ChatPoolEndpoint | ClassifierPoolEndpoint;

/** Per-attempt instructions from the pool: retry mode and budget. */
export interface AttemptSpec {
  /**
   * True when the walk has backups: every attempt then runs with the
   * transport's own retries off, because the walk itself is the retry — and
   * a backup's internal retries are each budgeted separately, so they could
   * push the walk past its ceiling. False only for a single-endpoint walk,
   * whose lone attempt keeps the transport's normal retry behavior.
   */
  hasFailover: boolean;
  /**
   * This attempt's request timeout: the endpoint's own `timeoutMs` trimmed
   * against the remaining walk budget (`walkRemainingMs`), never extended.
   */
  attemptTimeoutMs: number;
  /**
   * What is left of the whole walk's budget (`walkBudgetMs` minus the time
   * spent so far). A lane whose transport retries each get their own
   * timeout has to bound them with this: `attemptTimeoutMs` alone caps one
   * attempt, not their sum.
   */
  walkRemainingMs: number;
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
 * The failure the walk may still finalize: kept with its own endpoint and
 * position, since a floor stop ends the walk from the position it actually
 * failed at — not the loop index it stopped on.
 */
interface PendingFailure {
  attempt: Extract<AttemptResult, { kind: "retryable" }>;
  endpoint: PoolEndpoint;
  index: number;
}

/**
 * A hop the walk is about to audit: recorded when an endpoint fails
 * retryably, written once the endpoint it led to is known to run.
 */
interface HopRecord {
  failedEndpoint: number;
  nextEndpoint: number;
  modelId: string;
  reason: string;
}

/**
 * Floor for attempting another endpoint: below this remaining budget the
 * pool stops the walk and finalizes the last failure instead of firing a
 * request doomed to be cut off.
 */
const WALK_BUDGET_FLOOR_MS = 2_000;

/**
 * Default fallback timeout: matches the proxy-wide convention (LiteLLM
 * `request_timeout` defaults to 10s-class per-attempt budgets) — a slow
 * primary failing over to an equally slow backup doubles the worst case
 * for no reason. Explicit entries win.
 */
export const FALLBACK_TIMEOUT_DEFAULT_MS = 10_000;

/**
 * Audit identity for one pool position: the endpoint's bare identity plus
 * the backup's 1-based position. Owned by the pool (adapters report the bare
 * form) so one audit row reads the same whichever lane served it.
 *
 * @param id - The endpoint's bare audit identity.
 * @param index - The endpoint position (0 = primary, no suffix).
 * @returns The audit identity string.
 */
function withFallbackIndex(id: string, index: number): string {
  return index ? `${id} (fallback ${index})` : id;
}

export interface ReviewerPoolDeps {
  /** Ordered endpoints: primary first, backups after (at least one). */
  endpoints: PoolEndpoint[];
  /** Lane adapters, keyed by lane. */
  adapters: Record<PoolEndpoint["lane"], LaneAdapter>;
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
 * Settle one walk outcome: the endpoint's audit identity gains its walk
 * position (the pool owns the numbering), a backup verdict never caches (the
 * primary gets another chance next ask), and a verdict's latency covers the
 * whole walk (failover cost stays visible).
 *
 * @param terminal - The terminal record (identity NOT yet stamped).
 * @param endpoint - The endpoint that produced it.
 * @param index - The endpoint's position.
 * @param startedAt - The walk start (wall-clock latency covers the walk).
 * @param now - The clock.
 * @returns The settled record.
 */
function settleWalk(
  terminal: EngineAttemptResult,
  endpoint: PoolEndpoint,
  index: number,
  startedAt: number,
  now: () => number,
): EngineAttemptResult {
  const identified = { ...terminal, modelId: withFallbackIndex(endpoint.id, index) };
  if (isMachinery(identified)) return identified;
  const settled = {
    ...identified,
    outcome: { ...identified.outcome, latencyMs: now() - startedAt },
  };
  return index > 0 ? { ...settled, cacheable: false } : settled;
}

/**
 * Create the pooled reviewer engine: one loop over heterogeneous
 * endpoints, satisfying the `ReviewerEngine` seam so the pipeline stays
 * lane-blind.
 *
 * @param deps - The ordered endpoints and lane adapters.
 * @returns A `ReviewerEngine` whose review walks the endpoint list.
 */
export function createReviewerPool(deps: ReviewerPoolDeps): ReviewerEngine {
  const { endpoints, adapters } = deps;
  const now = deps.now ?? Date.now;
  const primary = endpoints[0];
  if (!primary) throw new Error("createReviewerPool requires at least one endpoint");
  const walkBudgetMs = deps.walkBudgetMs ?? Math.max(2 * primary.timeoutMs, 30_000);

  return {
    async review(ctx: EngineCallContext): Promise<EngineAttemptResult> {
      const startedAt = now();
      const deadline = startedAt + walkBudgetMs;
      // Per-walk state only: concurrent reviews never share it.
      let pendingFailure: PendingFailure | undefined;
      const settle = (
        terminal: EngineAttemptResult,
        endpoint: PoolEndpoint,
        index: number,
      ): EngineAttemptResult => settleWalk(terminal, endpoint, index, startedAt, now);
      let pendingHop: HopRecord | undefined;
      for (const [index, endpoint] of endpoints.entries()) {
        const remaining = deadline - now();
        // Below the floor no useful attempt fits: finalize the last
        // failure instead of firing a request doomed to be cut off.
        // Index 0 always runs (nothing to finalize yet). The remaining
        // budget never extends an endpoint's own timeout.
        if (pendingFailure && remaining < WALK_BUDGET_FLOOR_MS)
          return settle(
            pendingFailure.attempt.finalize(),
            pendingFailure.endpoint,
            pendingFailure.index,
          );
        // A hop is audited once the endpoint it led to is known to run: the
        // floor stop above can still cancel it, and the walk's own clock reads
        // cannot be compared across the two iterations.
        if (pendingHop) {
          // No URL, credential or upstream error body enters the review log.
          ctx.log.review(FALLBACK_EVENT, { requestId: ctx.requestId, ...pendingHop });
          pendingHop = undefined;
        }
        const attempt = await adapters[endpoint.lane].attempt(endpoint, ctx, {
          hasFailover: endpoints.length > 1,
          attemptTimeoutMs: Math.min(endpoint.timeoutMs, Math.max(remaining, 0)),
          walkRemainingMs: Math.max(remaining, 0),
        });
        if (attempt.kind !== "retryable") return settle(attempt.result, endpoint, index);
        pendingFailure = { attempt, endpoint, index };
        // Retryable on the last endpoint: it owns the terminal record
        // (debug emission included) — no further hop to audit.
        if (index + 1 >= endpoints.length) return settle(attempt.finalize(), endpoint, index);
        pendingHop = {
          failedEndpoint: index,
          nextEndpoint: index + 1,
          modelId: withFallbackIndex(endpoint.id, index),
          reason: attempt.reason,
        };
      }
      // The primary endpoint is always present, so the loop always returns.
      throw new Error("unreachable: no reviewer endpoints");
    },
  };
}
