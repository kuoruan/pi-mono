/**
 * Reviewer engine: the strategy seam between the review pipeline and the
 * reviewer backend.
 *
 * The pipeline owns everything engine-agnostic (openAsk, policy gate, breaker
 * pre-check, transcript stripping, cache lookup, mode mapping, disposition,
 * deny history, breaker/cache accounting). An engine owns only "turn this ask
 * into a ReviewOutcome": model resolution, auth, prompt/question building,
 * the call itself, and outcome parsing.
 *
 * Adapters: `createLlmEngine` (the pi ModelRegistry path) and
 * `createJevEngine` (the TypeSafe System One path).
 */

import type { AuthorizerLog } from "@gotgenes/pi-permission-system";

import type { ReviewOutcome } from "#src/model/model-verdict.ts";
import type { EngineMachineryKind } from "#src/review/machinery-kinds.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";

/** What an engine needs from the pipeline per ask (no engine reaches past this). */
export interface EngineCallContext {
  /** The stripped transcript (prompt material + cache fingerprint source). */
  transcript: StrippedTranscript;
  /** The review request (ask + target). */
  request: ReviewRequestContext;
  /** Audit log (call-failure and diagnostic records). */
  log: AuthorizerLog;
  /** Request id for audit-log correlation. */
  requestId: string;
}

/** What an engine reports back: the outcome plus its audit identity. */
export interface EngineReviewResult {
  /** The review outcome for the shared downstream. */
  outcome: ReviewOutcome;
  /** Audit identity, e.g. "cpa/lite" or "typesafe/jev-1.13". */
  modelId: string;
}

/** A reviewer backend: ask in, ReviewOutcome out. */
export interface ReviewerEngine {
  /**
   * Review one ask. Fail-safe: transport/parse failures resolve to defer.
   * Pre-call failures (the review never opened) return a tagged
   * {@link EngineMachineryFailure} for the pipeline's machinery lane.
   */
  review(ctx: EngineCallContext): Promise<EngineReviewResult | EngineMachineryFailure>;
}

/**
 * A pre-call failure that belongs to the machinery lane (the reviewer never
 * produced a verdict). The pipeline releases it via `releaseMachineryGate` —
 * the ritual stays in one place (disposition.ts).
 */
export interface EngineMachineryFailure {
  ok: false;
  kind: EngineMachineryKind;
  /** Audit identity of the engine that failed (e.g. "cpa/lite"). */
  modelId: string;
  /** Sanitized detail for the audit record (auth error text). */
  detail: string;
}

/**
 * Narrow an engine result to the machinery failure (pipeline-side helper).
 *
 * @param result - The engine result to narrow.
 * @returns True when the result is a machinery failure.
 */
export function isMachineryFailure(
  result: EngineReviewResult | EngineMachineryFailure,
): result is EngineMachineryFailure {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}
