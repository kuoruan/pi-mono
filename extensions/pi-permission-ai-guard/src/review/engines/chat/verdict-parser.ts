/**
 * The chat lane's tolerant JSON text parser: turn a model's free-text
 * reply into a `ReviewOutcome`. Tolerant by doctrine — providers wrap
 * JSON in prose, so the parser extracts the first balanced object
 * instead of demanding clean JSON, with two deliberate asymmetries:
 *
 * - A malformed _verdict-shaped_ candidate (e.g. unquoted keys, which repair cannot fix) stops the
 *   search rather than letting an unrelated later object override it — a broken deny must not flip
 *   to an allow.
 * - Non-verdict brace noise (`{var}`, markdown fragments) keeps scanning, so a model that mentions
 *   config syntax before the real verdict still parses.
 *
 * Everything else defers (fail-safe). The classifier lane never reaches
 * this module: its answers are calibrated probabilities, not text.
 */

import { parseJsonWithRepair } from "@earendil-works/pi-ai";

import type {
  ReviewOutcome,
  RiskLevel,
  VerdictKind,
  VerdictLean,
} from "#src/model/model-verdict.ts";
import { GENERIC_DENY_REASON } from "#src/model/model-verdict.ts";
import { isObjectRecord, normalizeAndRedactText, safeStringify } from "#src/utils.ts";

/**
 * The valid lean values. The `VerdictLean` type argument rejects a bad
 * member at compile time; it cannot catch an omission, so a new lean means
 * editing this line too.
 */
const VERDICT_LEANS: ReadonlySet<string> = new Set<VerdictLean>(["allow", "deny"]);

/**
 * Type guard: is `value` a valid lean?
 *
 * @param value - The string to test.
 * @returns True if `value` is a valid lean (type-narrowed).
 */
function isVerdictLean(value: string): value is VerdictLean {
  return VERDICT_LEANS.has(value);
}

/**
 * Parse the lean field off a defer verdict. Tolerant by doctrine: the
 * verdict itself parsed cleanly, so a bonus field's invalid value
 * ("maybe", "unsure", a number) degrades to neutral — a defer is never
 * invalidated by its lean.
 *
 * @param value - The raw `lean` field from the model's JSON reply.
 * @returns The lean when valid, or undefined (neutral).
 */
function parseLean(value: unknown): VerdictLean | undefined {
  return typeof value === "string" && isVerdictLean(value) ? value : undefined;
}

/**
 * The valid risk levels. The `RiskLevel` type argument rejects a bad member
 * at compile time; it cannot catch an omission, so a new level means
 * editing this line too.
 */
const RISK_LEVELS: ReadonlySet<string> = new Set<RiskLevel>(["low", "medium", "high", "critical"]);

/** The valid verdicts, derived from {@link VerdictKind} (the single source of truth). */
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

/**
 * Read the risk level off a verdict object, ignoring anything unknown.
 *
 * @param value - The raw `riskLevel` field.
 * @returns The risk level when valid, else undefined.
 */
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
 * - A verdict-shaped fragment that cannot become an object stops the search and returns `null`,
 *   balanced or not: unquoted keys, a cut-off quote, or a lost closing brace. A broken verdict is
 *   never overridden by an unrelated later object (prevents a deny→allow flip when the model wraps
 *   a malformed deny and then includes an allow example in its reasoning).
 * - Non-verdict-shaped brace noise (e.g. `{var}`, `{bad}`, template/markdown fragments) keeps
 *   scanning — preserving recovery when the model mentions config syntax before the real verdict
 *   JSON.
 * - A reply stating two different verdicts also returns `null`: a self-contradictory reply must not
 *   let the first object decide the ask.
 *
 * Returns `null` if no parseable object is found.
 *
 * @param text - The text to search.
 * @returns The first parseable JSON object, or `null` if none is found (or the search
 *   short-circuits).
 */
function extractFirstJsonObject(text: string): unknown | null {
  let start = 0;
  let found: unknown | null = null;
  let foundVerdict: string | undefined;
  while (start < text.length) {
    const nextBrace = findNextCharOutsideString(text, start, "{");
    if (nextBrace < 0) return found;
    const candidate = tryExtractBalanced(text, nextBrace);
    // A cut-off verdict never reaches the parse below, so catch it here: its lost
    // closing brace must not let a later allow example decide the ask.
    if (candidate === null && looksLikeVerdictAttempt(text.slice(nextBrace))) return null;
    if (candidate !== null) {
      try {
        const parsed = parseJsonWithRepair(candidate);
        const kind = verdictKindOf(parsed);
        if (found === null) {
          found = parsed;
          foundVerdict = kind;
        } else if (
          // Two disagreeing verdicts make the reply self-contradictory, and
          // letting the first win would let an allow printed before the real
          // deny decide the ask. `null` means unresolved (a defer).
          foundVerdict !== undefined &&
          kind !== undefined &&
          kind !== foundVerdict
        ) {
          return null;
        }
      } catch {
        // A malformed verdict attempt defers rather than being overridden by
        // an unrelated later object; other brace noise keeps scanning.
        if (looksLikeVerdictAttempt(candidate)) return null;
      }
    }
    start = nextBrace + 1;
  }
  return found;
}

/**
 * The `verdict` string a parsed object declares, when it declares one.
 *
 * @param value - A parsed JSON value.
 * @returns The declared verdict kind, or undefined for anything else.
 */
function verdictKindOf(value: unknown): string | undefined {
  if (!isObjectRecord(value)) return undefined;
  const verdict = value.verdict;
  return typeof verdict === "string" ? verdict : undefined;
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
