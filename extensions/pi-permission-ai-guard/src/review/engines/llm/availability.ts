/** Availability categories safe to expose in review logs (never provider error text). */
export type AvailabilityReason = "quota" | "timeout" | "connection" | `http-${number}`;

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
  const fields = typeof error === "object" && error !== null ? error : {};
  const response = "response" in fields ? fields.response : undefined;
  const nested =
    typeof response === "object" && response !== null
      ? response
      : "cause" in fields
        ? fields.cause
        : undefined;
  const nestedFields = typeof nested === "object" && nested !== null ? nested : {};
  const status =
    ("status" in fields ? fields.status : undefined) ??
    ("statusCode" in fields ? fields.statusCode : undefined) ??
    ("status" in nestedFields ? nestedFields.status : undefined);
  if (typeof status === "number") {
    return [402, 404, 408, 409, 410, 425, 429].includes(status) || (status >= 500 && status < 600)
      ? `http-${status}`
      : undefined;
  }
  const code =
    ("code" in fields ? fields.code : undefined) ??
    ("code" in nestedFields ? nestedFields.code : undefined);
  if (
    typeof code === "string" &&
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code)
  ) {
    return "connection";
  }
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  // A wrapped 403 can also mention quota or a 429 in its body. Refuse to
  // route around any explicit auth, policy or invalid-request HTTP status.
  if (
    /\b(?:400|401|403|405|406|407|411|412|413|414|415|422|423|424|451)\b/.test(message) ||
    /\b(?:unauthori[sz]ed|forbidden|access denied|permission denied|policy blocked|content blocked|invalid (?:request|api key)|authentication failed)\b/i.test(
      message,
    )
  ) {
    return undefined;
  }
  // Provider errors often resolve into AssistantMessage.errorMessage without
  // a typed status. Match a prefixed status or an explicit status field;
  // unrelated numbers in error bodies must not become HTTP status codes.
  const http =
    /^(?:(?:Error:\s*)?HTTP(?:\/\d(?:\.\d)?)?\s*|Error:\s*)?(\d{3})\b/i.exec(message.trim()) ??
    /\b(?:status(?: code)?|upstream returned)\s*[:=]?\s*(\d{3})\b/i.exec(message);
  if (http) {
    const parsed = Number(http[1]);
    return [402, 404, 408, 409, 410, 425, 429].includes(parsed) || (parsed >= 500 && parsed < 600)
      ? `http-${parsed}`
      : undefined;
  }
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "timeout";
  }
  if (/^(?:request |operation )?(?:timed out|timeout|aborted)\b/i.test(message.trim())) {
    return "timeout";
  }
  if (
    /\b(?:FreeUsageLimitError|GoUsageLimitError|insufficient_quota|quota exceeded|out of budget)\b/i.test(
      message,
    )
  ) {
    return "quota";
  }
  if (
    /^(?:fetch failed|network error|connection (?:refused|lost|error)|socket hang up|service unavailable)\b/i.test(
      message.trim(),
    )
  ) {
    return "connection";
  }
  return undefined;
}
