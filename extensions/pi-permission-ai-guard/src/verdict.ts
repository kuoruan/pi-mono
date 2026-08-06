import { parseJsonWithRepair } from "@earendil-works/pi-ai";
import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { isObjectRecord, normalizeAndRedactText } from "./utils.ts";

/** Why a model call deferred (for logging/debugging). */
export type ModelCallDeferReason =
  | "empty-reply"
  | "no-json"
  | "invalid-verdict-value"
  | "timeout"
  | "call-failed"
  | "model-defer";

/** Result of a model review call. */
export interface ReviewOutcome {
  /** The verdict (allow / deny / defer). */
  verdict: AuthorizerVerdict;
  /** Why the call deferred, when verdict is defer. */
  deferReason?: ModelCallDeferReason;
  /** Model call latency in milliseconds. */
  latencyMs: number;
  /** Raw model reply (for debug logging). */
  rawReply?: string;
  /** Risk level from the model verdict, if provided. */
  riskLevel?: RiskLevel;
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
type VerdictKind = AuthorizerVerdict["kind"];

/**
 * The valid risk levels as a readonly set, derived from {@link RiskLevel}
 * so the runtime check and the type can never drift apart. Built once at
 * module load; membership lookups are O(1).
 */
const RISK_LEVELS: ReadonlySet<RiskLevel> = new Set<RiskLevel>([
  "low",
  "medium",
  "high",
  "critical",
]);

const VERDICT_VALUES: ReadonlySet<VerdictKind> = new Set<VerdictKind>(["allow", "deny", "defer"]);

export const GENERIC_DENY_REASON =
  "This action may be unsafe. Verify the target and intent before retrying.";

/**
 * Type guard: is `value` one of the risk levels?
 *
 * @param value - The string to test.
 * @returns True if `value` is a valid risk level (type-narrowed to `RiskLevel`).
 */
function isRiskLevel(value: string): value is RiskLevel {
  return RISK_LEVELS.has(value as RiskLevel);
}

/**
 * Safely stringify a value to JSON, guarding against cycles or BigInt.
 * Returns "[unstringifiable]" on failure instead of throwing.
 *
 * @param value - The value to stringify.
 * @returns The JSON string, or `"[unstringifiable]"` if stringification threw.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unstringifiable]";
  }
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
  if (typeof verdict !== "string" || !VERDICT_VALUES.has(verdict as VerdictKind)) {
    return {
      verdict: { kind: "defer" },
      deferReason: "invalid-verdict-value",
      latencyMs,
      rawReply: raw,
    };
  }
  const riskLevel = parseRiskLevel(args.riskLevel);
  if (verdict === "defer") {
    return {
      verdict: { kind: "defer" },
      deferReason: "model-defer",
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
    const rawReason = typeof args.reason === "string" ? args.reason : "";
    const reason = normalizeAndRedactText(rawReason) || GENERIC_DENY_REASON;
    return { verdict: { kind: "deny", reason }, latencyMs, riskLevel, rawReply: raw };
  }
  return { verdict: { kind: "allow" }, latencyMs, riskLevel, rawReply: raw };
}

function parseRiskLevel(value: unknown): RiskLevel | undefined {
  return typeof value === "string" && isRiskLevel(value) ? value : undefined;
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
  return { verdict: { kind: "defer" }, deferReason: "no-json", latencyMs, rawReply: text };
}

/**
 * Extract the first balanced JSON object from a string and return it parsed.
 * Tracks brace depth and respects string literals (including escaped quotes).
 * If the first balanced object fails to parse, continues searching.
 * Returns null if no parseable object is found.
 *
 * @param text - The text to search.
 * @returns The first parseable JSON object, or null if none is found.
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
        // not parseable, continue searching
      }
    }
    start = nextBrace + 1;
  }
  return null;
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
