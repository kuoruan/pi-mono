/**
 * The call-failure audit sink — the single place a thrown model call lands
 * in the debug log. Both engines share it (the LLM call path and the Jev
 * adapter); it lives here, in the audit cluster, so neither lane depends
 * on the other.
 */

import type { ModelCallDeferKind } from "#src/model/model-verdict.ts";
import { errorMessage, normalizeAndRedactText, truncateMiddle } from "#src/utils.ts";

import type { AuditCorrelation } from "./decision-record.ts";
import { MODEL_CALL_ERROR_EVENT } from "./events.ts";

/**
 * Max chars of provider error text kept in diagnostics. Provider error pages
 * (e.g. Cloudflare HTML) must not land in the log unbounded — the transcript
 * feeds logs back into the next request's state, and a WAF then blocks its own
 * error page.
 */
export const MAX_PROVIDER_ERROR_CHARS = 300;

/**
 * Emit a call-failure record to the audit log (keyed by requestId).
 *
 * Takes the minimal log/requestId surface so both engines share it: the LLM
 * `ModelCallContext` and the Jev `EngineCallContext` each carry these fields.
 *
 * The provider's error text is sanitized and truncated here, once, for every
 * caller: error pages (e.g. Cloudflare HTML) must not land in the log unbounded —
 * the transcript feeds logs back into the next request's state, and a WAF then
 * blocks its own error page.
 *
 * @param ctx - The log + request id (a slice of either call context).
 * @param deferKind - The classified defer kind.
 * @param error - The thrown error.
 */
export function emitCallFailure(
  ctx: AuditCorrelation,
  deferKind: ModelCallDeferKind,
  error: unknown,
): void {
  ctx.log.debug(MODEL_CALL_ERROR_EVENT, {
    requestId: ctx.requestId,
    deferKind,
    error: truncateMiddle(normalizeAndRedactText(errorMessage(error)), MAX_PROVIDER_ERROR_CHARS),
  });
}
