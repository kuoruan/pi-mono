/**
 * Failure taxonomy: the single table deciding whether a backend failure
 * switches to the next endpoint or ends the ask as a terminal defer.
 * One module behind a small interface — "given what the backend said,
 * switch or terminal, and with what defer kind".
 *
 * Two lanes feed it, each in the shape its backend produces:
 *
 * - The chat lane throws or returns untyped provider errors (strings, Error-likes, status-shaped
 *   objects) — `availabilityReason` reads them with the shared switchable table plus message
 *   regexes;
 * - The classifier lane throws typed SDK errors — `failoverReason`/`classifyFailure` read them by
 *   `instanceof`, then by the same table for the status they carry.
 *
 * Failover switches backends, it does not hammer the same one: a
 * different backend has no 409 conflict state, so 409/425 switch here
 * even though a same-backend retry never covered them. And failover
 * never routes around a provider's refusal: auth/policy/invalid-request
 * signals — by status or by phrase — are terminal defers for the
 * operator. Status takes precedence over message text, so a 403
 * mentioning "rate limit" cannot silently route around a refusal.
 */

import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";

import type { AvailabilityReason, ModelCallDeferKind } from "#src/model/model-verdict.ts";
import { classifyAbortish } from "#src/utils.ts";

/** HTTP statuses that switch backends (failover, not same-backend retry). */
const SWITCHABLE_STATUS: ReadonlySet<number> = new Set([402, 404, 408, 409, 410, 425, 429]);

/**
 * Classify a numeric HTTP status by the shared switchable table.
 *
 * @param status - The HTTP status (or unknown value).
 * @returns The `http-xxx` reason when the status switches, else undefined.
 */
export function switchableStatusReason(status: unknown): AvailabilityReason | undefined {
  return typeof status === "number" &&
    (SWITCHABLE_STATUS.has(status) || (status >= 500 && status < 600))
    ? `http-${status}`
    : undefined;
}

/** Node error codes that mean the connection never served the request. */
const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

/** Auth/policy/invalid-request signals: never route around a provider's refusal. */
const REFUSAL_STATUS = /\b(?:400|401|403|405|406|407|411|412|413|414|415|422|423|424|451)\b/;
const REFUSAL_PHRASE =
  /\b(?:unauthori[sz]ed|forbidden|access denied|permission denied|policy blocked|content blocked|invalid (?:request|api key)|authentication failed)\b/i;

/** Timeout signals (matched against trimmed input). */
const TIMEOUT_RULE = /^(?:request |operation )?(?:timed out|timeout|aborted)\b/i;

/** Quota signals (matched anywhere — evaluation order preserved: quota before connection). */
const QUOTA_RULE =
  /\b(?:FreeUsageLimitError|GoUsageLimitError|insufficient_quota|quota exceeded|out of budget)\b/i;

/** Connection signals (matched against trimmed input). */
const CONNECTION_RULE =
  /^(?:fetch failed|network error|connection (?:refused|lost|error)|socket hang up|service unavailable)\b/i;

/**
 * Read a field off an error-shaped object without throwing on accessors.
 *
 * @param error - The thrown value or wrapper object.
 * @param key - The field to read.
 * @returns The field value, or undefined when absent/unreadable.
 */
function errorField(error: unknown, key: string): unknown {
  try {
    if (typeof error === "object" && error !== null && key in error) {
      return (error as Record<string, unknown>)[key];
    }
  } catch {
    // A throwing getter is not a status — ignore it.
  }
  return undefined;
}

/**
 * Identify service outages without mistaking auth/policy refusals for outages.
 * Pi providers may throw errors or return a stopReason:error reply. Status
 * takes precedence over message text, so a 403 mentioning "rate limit"
 * cannot silently route the request around a provider's refusal.
 *
 * @param error - A thrown provider error or the errorMessage of a failed reply.
 * @returns Safe reason for trying the next model, if known.
 */
export function availabilityReason(error: unknown): AvailabilityReason | undefined {
  // A present status field is authoritative and fail-closed: numeric
  // values classify by the shared table, non-numeric values never
  // switch. A typed refusal (e.g. 403) stops here and never falls
  // through to a nested 5xx. Only when no top-level status exists do
  // we consult response/cause chains.
  const topStatus = errorField(error, "status") ?? errorField(error, "statusCode");
  if (topStatus !== undefined) return switchableStatusReason(topStatus);
  const response = errorField(error, "response");
  const nested =
    typeof response === "object" && response !== null ? response : errorField(error, "cause");
  const nestedStatus =
    typeof nested === "object" && nested !== null ? errorField(nested, "status") : undefined;
  if (nestedStatus !== undefined) return switchableStatusReason(nestedStatus);
  const code = errorField(error, "code") ?? errorField(nested, "code");
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return "connection";
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  // A wrapped 403 can also mention quota or a 429 in its body. Refuse to
  // route around any explicit auth, policy or invalid-request HTTP status.
  if (REFUSAL_STATUS.test(message) || REFUSAL_PHRASE.test(message)) return undefined;
  // Provider errors often resolve into AssistantMessage.errorMessage without
  // a typed status. Match a prefixed status or an explicit status field;
  // unrelated numbers in error bodies must not become HTTP status codes.
  const trimmed = message.trim();
  const http =
    /^(?:(?:Error:\s*)?HTTP(?:\/\d(?:\.\d)?)?\s*|Error:\s*)?(\d{3})\b/i.exec(trimmed) ??
    /\b(?:status(?: code)?|upstream returned)\s*[:=]?\s*(\d{3})\b/i.exec(message);
  if (http) return switchableStatusReason(Number(http[1]));
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "timeout";
  }
  if (TIMEOUT_RULE.test(trimmed)) return "timeout";
  if (QUOTA_RULE.test(message)) return "quota";
  if (CONNECTION_RULE.test(trimmed)) return "connection";
  return undefined;
}

/**
 * Classify a failed classifier call into the terminal defer kind.
 *
 * @param error - The thrown SDK error.
 * @returns The defer kind for the terminal record.
 */
export function classifyFailure(error: unknown): ModelCallDeferKind {
  if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return "timeout";
  return classifyAbortish(error) ?? "call-failed";
}

/**
 * Fail over only when the backend could not serve the request. Never turn a
 * valid deny/defer into a second opinion, or resend an invalid request.
 *
 * @param error - The thrown SDK error.
 * @returns The switch reason, or undefined when the failure is terminal.
 */
export function failoverReason(error: unknown): AvailabilityReason | undefined {
  if (error instanceof APIUserAbortError) return undefined;
  if (error instanceof APIError) return switchableStatusReason(error.status);
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection";
  return classifyAbortish(error) === "timeout" ? "timeout" : undefined;
}
