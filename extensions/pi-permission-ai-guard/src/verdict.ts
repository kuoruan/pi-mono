import { parseJsonWithRepair } from "@earendil-works/pi-ai";
import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { isObjectRecord, normalizeAndRedactText, safeStringify } from "./utils.ts";

/** Why a model call deferred (for logging/debugging). */
export type ModelCallDeferKind =
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
  /** Classified defer reason (timeout / empty-reply / no-json / model-defer / etc.). */
  deferKind?: ModelCallDeferKind;
  /** Model explanation for a defer verdict, retained for audit logging. */
  deferReason?: string;
  /** Model call latency in milliseconds. */
  latencyMs: number;
  /** Raw model reply (for debug logging). */
  rawReply?: string;
  /** Risk level from the model verdict, if provided. */
  riskLevel?: RiskLevel;
  /**
   * Empty/aborted-reply diagnostics, present only when the reply carried
   * no text — see {@link ReviewOutcomeDiagnostic}.
   */
  diagnostic?: ReviewOutcomeDiagnostic;
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
type VerdictKind = AuthorizerVerdict["kind"];

/**
 * The deny reason attached when the model denies without one — the prompt
 * demands a reason, but a terse model may omit it; this default keeps the
 * teaching signal present.
 */
export const GENERIC_DENY_REASON =
  "This action may be unsafe. Verify the target and intent before retrying.";

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
 * Normalize a model-provided explanation for the permission UI or audit log.
 *
 * @param value - Model-provided reason value.
 * @returns A safe explanation, or undefined when it has no text content.
 */
function normalizeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reason = normalizeAndRedactText(value);
  return reason || undefined;
}

function parseRiskLevel(value: unknown): RiskLevel | undefined {
  return typeof value === "string" && isRiskLevel(value) ? value : undefined;
}

/**
 * Does a failed JSON fragment look like an attempted verdict object?
 *
 * Matches an unquoted-or-quoted `verdict` key (e.g. `{verdict:`, `{"verdict":`).
 * Used to distinguish a malformed verdict (stop, defer) from non-verdict
 * brace noise like `{var}` or `{bad}` (skip, keep scanning).
 *
 * @param fragment - The balanced-but-unparseable candidate substring.
 * @returns True if the fragment carries a `verdict:` key.
 */
function looksLikeVerdictAttempt(fragment: string): boolean {
  return /["']?verdict["']?\s*:/i.test(fragment);
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
 * - A malformed verdict-shaped candidate (e.g. `{verdict: "deny", reason: "x"}`
 * with unquoted keys, which `parseJsonWithRepair` does not fix) stops the
 * search and returns `null` — so a broken verdict is never overridden by an
 * unrelated later object (prevents a deny→allow flip when the model wraps a
 * malformed deny and then includes an allow example in its reasoning).
 * - Non-verdict-shaped brace noise (e.g. `{var}`, `{bad}`, template/markdown
 * fragments) keeps scanning — preserving recovery when the model mentions
 * config syntax before the real verdict JSON.
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
  if (typeof verdict !== "string" || !VERDICT_VALUES.has(verdict as VerdictKind)) {
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
