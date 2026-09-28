import { parseJsonWithRepair } from "@earendil-works/pi-ai";
import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { isObjectRecord, normalizeAndRedactText, safeStringify } from "#src/utils.ts";

/**
 * Safe availability-failure category for ordered failover; never an
 * error body. Adapters report one of these when the backend could not
 * serve the request; the pool advances to the next endpoint on it.
 */
export type AvailabilityReason =
  | "quota"
  | "timeout"
  | "connection"
  | "model-unresolved"
  | `http-${number}`;

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

/** Why a model call deferred (for logging/debugging). */
export type ModelCallDeferKind =
  | "empty-reply"
  | "no-json"
  | "invalid-verdict-value"
  | "timeout"
  | "call-failed"
  | "model-defer";

/**
 * The reviewer's directional inclination on a defer verdict: which way it
 * would decide if forced to pick now. Absent means genuinely neutral.
 * Routing-only signal — never surfaced to the human (dialogs and notify
 * lines carry the clarification question, not the lean), so it cannot
 * anchor the operator's judgment.
 */
export type VerdictLean = "allow" | "deny";

/**
 * The valid lean values as a readonly set (derived so check and type never drift — see
 * {@link RISK_LEVELS}).
 */
const VERDICT_LEANS: ReadonlySet<string> = new Set<VerdictLean>(["allow", "deny"]);

/**
 * Parse the lean field off a defer verdict. Tolerant by doctrine: the
 * verdict itself parsed cleanly, so a bonus field's invalid value
 * ("maybe", "unsure", a number) degrades to neutral — a defer is never
 * invalidated by its lean.
 *
 * @param value - The raw `lean` field from the model's JSON reply.
 * @returns The lean when valid, or undefined (neutral).
 */
function isVerdictLean(value: string): value is VerdictLean {
  return VERDICT_LEANS.has(value);
}

/**
 * Parse and validate the lean value from the model's JSON reply.
 *
 * @param value - The raw `lean` field from the model's JSON reply.
 * @returns The lean when valid, or undefined (neutral).
 */
function parseLean(value: unknown): VerdictLean | undefined {
  return typeof value === "string" && isVerdictLean(value) ? value : undefined;
}

/** Result of a model review call. */
export interface ReviewOutcome {
  /** The verdict (allow / deny / defer). */
  verdict: AuthorizerVerdict;
  /** Classified defer reason (timeout / empty-reply / no-json / model-defer / etc.). */
  deferKind?: ModelCallDeferKind;
  /** Safe availability failure category for ordered failover; never an error body. */
  availabilityReason?: AvailabilityReason;
  /** Model explanation for a defer verdict, retained for audit logging. */
  deferReason?: string;
  /**
   * The reviewer's directional inclination on a defer (which way it would
   * decide if forced); undefined means neutral. Present only on
   * model-defer outcomes.
   */
  lean?: VerdictLean;
  /** Model call latency in milliseconds (cumulative across attempts). */
  latencyMs: number;
  /** How many executeCall attempts produced this outcome (1, or 2 after the empty-reply retry). */
  attempts?: number;
  /** Raw model reply (for debug logging). */
  rawReply?: string;
  /** Risk level from the model verdict, if provided. */
  riskLevel?: RiskLevel;
  /**
   * Empty/aborted-reply diagnostics, present only when the reply carried
   * no text — see {@link ReviewOutcomeDiagnostic}.
   */
  diagnostic?: ReviewOutcomeDiagnostic;
  /** The latest trusted user message the intent check judged against (audit-only). */
  anchorText?: string;
}

/**
 * Why a model reply carried no text, captured when the reply is empty or
 * aborted. Persisted into the decision record so the review log is
 * self-diagnosing even with the permission system's debug log disabled.
 */
export interface ReviewOutcomeDiagnostic {
  /** The provider stop reason (null when unknown). */
  stopReason: string | null;
  /** The UNADJUSTED provider stop reason (through the aborted reclassification). */
  rawStopReason: string | null;
  /** Content-block types present in the reply ("" text implies "text"). */
  contentTypes: string[];
  /** Sanitized provider error message, when the reply carried one. */
  errorMessage: string | null;
}

/**
 * Risk level assessed by the model (optional, for audit logging).
 * The single source of truth — the runtime set below is derived from this
 * type, so adding a member updates both in one place.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * The valid verdict values, derived from {@link AuthorizerVerdict}["kind"] —
 * the upstream type is the single source of truth. Used to validate the
 * `verdict` field the model returns in its JSON reply.
 */
export type VerdictKind = AuthorizerVerdict["kind"];

/**
 * A non-allow verdict's origin kind (deny or defer) — the mapping's input
 * origins, and exactly the lane kinds a machinery lane may target
 * (never allow). Derived from the upstream verdict, which is the single
 * source of truth.
 */
export type VerdictOrigin = Exclude<VerdictKind, "allow">;

/**
 * The deny reason attached when the model denies without one — the prompt
 * demands a reason, but a terse model may omit it; this default keeps the
 * teaching signal present.
 */
export const GENERIC_DENY_REASON =
  "This action may be unsafe. Verify the target and intent before retrying.";

/**
 * The valid risk levels as a readonly set, derived from {@link RiskLevel}
 * so the runtime check and the type can never drift apart.
 */
const RISK_LEVELS: ReadonlySet<string> = new Set<RiskLevel>(["low", "medium", "high", "critical"]);

const VERDICT_VALUES: ReadonlySet<string> = new Set<VerdictKind>(["allow", "deny", "defer"]);

/**
 * Type guard: is `value` one of the risk levels?
 *
 * @param value - The string to test.
 * @returns True if `value` is a valid risk level (type-narrowed to `RiskLevel`).
 */
function isRiskLevel(value: string): value is RiskLevel {
  return RISK_LEVELS.has(value);
}

/**
 * Normalize a model-provided explanation for the permission UI or audit log.
 *
 * @param value - Model-provided reason value.
 * @returns A safe explanation, or undefined when it has no text content.
 */
function normalizeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeAndRedactText(value) || undefined;
}

function parseRiskLevel(value: unknown): RiskLevel | undefined {
  return typeof value === "string" && isRiskLevel(value) ? value : undefined;
}

/**
 * An attempted verdict object's signature: a `verdict:` or `verdict=` key
 * (quoted or not) — how a malformed verdict attempt is told from unrelated
 * brace noise.
 */
const VERDICT_KEY_PROBE = /["']?verdict["']?\s*[:=]/i;

/**
 * Does a failed JSON fragment look like an attempted verdict object?
 *
 * Matches an unquoted-or-quoted `verdict` key followed by `:` or `=`
 * (e.g. `{verdict:`, `{"verdict":`, `{verdict=`), as opposed to unrelated
 * brace noise like `{var}` or `{bad}` (skip, keep scanning).
 *
 * @param fragment - The balanced-but-unparseable candidate substring.
 * @returns True if the fragment carries a `verdict` key (`:` or `=` form).
 */
function looksLikeVerdictAttempt(fragment: string): boolean {
  return VERDICT_KEY_PROBE.test(fragment);
}

/**
 * Find the next occurrence of `target` char outside string literals.
 *
 * @param text - The text to search.
 * @param from - Index to start searching from.
 * @param target - The character to find.
 * @returns The index of the next occurrence, or -1 if not found.
 */
function findNextCharOutsideString(text: string, from: number, target: string): number {
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === target) return i;
  }
  return -1;
}

/**
 * From a `{` at `start`, extract the balanced `{...}` substring.
 * Returns null if unbalanced.
 *
 * @param text - The text to extract from.
 * @param start - Index of the opening `{`.
 * @returns The balanced `{...}` substring, or null if unbalanced.
 */
function tryExtractBalanced(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract the first balanced JSON object from a string and return it parsed.
 * Tracks brace depth and respects string literals (including escaped quotes).
 *
 * If the first balanced object fails to parse, the recovery depends on whether
 * it looks like a verdict attempt:
 *
 * - A malformed verdict-shaped candidate (e.g. `{verdict: "deny", reason: "x"}` with unquoted keys,
 *   which `parseJsonWithRepair` does not fix) stops the search and returns `null` — so a broken
 *   verdict is never overridden by an unrelated later object (prevents a deny→allow flip when the
 *   model wraps a malformed deny and then includes an allow example in its reasoning).
 * - Non-verdict-shaped brace noise (e.g. `{var}`, `{bad}`, template/markdown fragments) keeps
 *   scanning — preserving recovery when the model mentions config syntax before the real verdict
 *   JSON.
 *
 * Returns `null` if no parseable object is found.
 *
 * @param text - The text to search.
 * @returns The first parseable JSON object, or `null` if none is found (or a
 *   malformed verdict attempt short-circuits the search).
 */
function extractFirstJsonObject(text: string): unknown | null {
  let start = 0;
  while (start < text.length) {
    const nextBrace = findNextCharOutsideString(text, start, "{");
    if (nextBrace < 0) return null;
    const candidate = tryExtractBalanced(text, nextBrace);
    if (candidate !== null) {
      try {
        return parseJsonWithRepair(candidate);
      } catch {
        // A malformed verdict attempt defers rather than being overridden by
        // an unrelated later object; other brace noise keeps scanning.
        if (looksLikeVerdictAttempt(candidate)) return null;
      }
    }
    start = nextBrace + 1;
  }
  return null;
}

/**
 * Parse a verdict object (extracted from the model's JSON text reply) into a
 * ReviewOutcome. Anything other than a clean verdict defers (fail-safe).
 *
 * @param args - The parsed verdict object from the model's JSON reply.
 * @param latencyMs - Model call latency in milliseconds.
 * @returns A `ReviewOutcome` with the parsed verdict, or a defer outcome for invalid/missing
 *   verdicts.
 */
export function parseVerdictObject(
  args: Record<string, unknown>,
  latencyMs: number,
): ReviewOutcome {
  const verdict = args.verdict;
  const raw = safeStringify(args);
  if (typeof verdict !== "string" || !VERDICT_VALUES.has(verdict)) {
    return {
      verdict: { kind: "defer" },
      deferKind: "invalid-verdict-value",
      latencyMs,
      rawReply: raw,
    };
  }
  const riskLevel = parseRiskLevel(args.riskLevel);
  if (verdict === "defer") {
    return {
      verdict: { kind: "defer" },
      deferKind: "model-defer",
      deferReason: normalizeReason(args.reason),
      lean: parseLean(args.lean),
      latencyMs,
      riskLevel,
      rawReply: raw,
    };
  }
  if (verdict === "deny") {
    // The deny reason is model-generated text. It is structurally sanitized
    // (normalizeAndRedactText: strips zero-width chars, collapses whitespace,
    // redacts secrets) but NOT semantically filtered. It is passed back as
    // AuthorizerVerdict.reason (a "teaching reason" the invoking agent sees)
    // and persisted in the audit log. This is safe under the trust
    // assumption that the reviewer model is operator-configured and
    // trusted — it is not adversarial. If that assumption ever breaks (e.g.
    // untrusted reviewer, cross-tenant reviewer), semantic filtering would
    // be needed to prevent prompt-injection via the reason text.
    const reason = normalizeReason(args.reason) ?? GENERIC_DENY_REASON;
    return { verdict: { kind: "deny", reason }, latencyMs, riskLevel, rawReply: raw };
  }
  return { verdict: { kind: "allow" }, latencyMs, riskLevel, rawReply: raw };
}

/**
 * Parse the model's text reply. Extracts the first balanced JSON object and
 * reads it as a verdict. Returns the text as rawReply for logging.
 *
 * @param text - The model's raw text reply.
 * @param latencyMs - Model call latency in milliseconds.
 * @returns A `ReviewOutcome` parsed from the first JSON object, or a `no-json` defer outcome if
 *   none is found.
 */
export function parseTextFallback(text: string, latencyMs: number): ReviewOutcome {
  const parsed = extractFirstJsonObject(text);
  if (isObjectRecord(parsed)) {
    return parseVerdictObject(parsed, latencyMs);
  }
  return { verdict: { kind: "defer" }, deferKind: "no-json", latencyMs, rawReply: text };
}
