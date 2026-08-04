/**
 * Shared prompt-sanitization and small helpers used across modules.
 *
 * - Sanitize: strip zero-width chars + collapse whitespace (anti-injection)
 * - SanitizeForPrompt: sanitize + redact secrets (for model context / logs)
 * - RedactSecrets: scrub common credential patterns
 * - Truncate: head+tail string truncation
 * - IsRecord: type guard for plain objects
 *
 * Single-consumer helpers (extractFirstJsonObject, safeStringify, shortHash)
 * have been inlined into their consumers (verdict.ts, review-pipeline.ts).
 */

/**
 * Bare-token patterns: no key name, replace the entire match with
 * [REDACTED]. Run before the key=value pattern so a bare token inside a
 * value (e.g. `password=AKIA...`) is caught first.
 */
const SECRET_PATTERNS: RegExp[] = [
  // AWS access key id (20 chars, starts AKIA)
  /AKIA[0-9A-Z]{16}/g,
  // Anthropic API key (sk-ant-...)
  /sk-ant-[a-zA-Z0-9_-]+/g,
  // Generic OpenAI / "sk-" keys (require ≥20 chars after sk- to avoid matching "skip")
  /sk-[a-zA-Z0-9]{20,}/g,
  // Bearer tokens (require ≥8 chars after; \s or : separator to cover
  // both "Bearer <token>" and "Bearer:<token>" forms)
  /bearer[\s:]+[a-zA-Z0-9._-]{8,}/gi,
  // PEM private key blocks. sanitize() runs first and collapses newlines to
  // spaces, so the block arrives as a single line — `.*?` suffices.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Key=value assignments: preserve the key name, redact only the value.
 * The value may be bare (\S+), double-quoted, or single-quoted — quoted forms
 * are matched first so a value containing spaces (e.g. password="my secret")
 * is redacted whole instead of leaving residue after the opening quote.
 */
const GENERIC_ASSIGNMENT_PATTERN =
  /(password|passwd|passphrase|token|secret|api_key|apikey|credential|private_key|privatekey|aws_secret_access_key|aws_access_key_id)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Sanitize untrusted text before embedding it in prompts.
 *
 * Strips zero-width characters (ZWSP, ZWNJ, ZWJ, WJ, BOM) that bypass
 * `\s` matching and can obscure injection payloads, then collapses
 * all whitespace to single spaces and trims — preventing section header
 * injection via newlines.
 *
 * @param text - Untrusted text to sanitize.
 * @returns Sanitized text with zero-width chars removed and whitespace collapsed.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Redact common secret/credential patterns from text, replacing values with
 * `[REDACTED]`. Idempotent: redacting an already-redacted string is a no-op
 * (the placeholder contains no credential-shaped value).
 *
 * Applied AFTER sanitize() in prompt building, so whitespace is already
 * collapsed and zero-width chars stripped.
 *
 * @param text - Text to redact secrets from.
 * @returns Text with credential patterns replaced by `[REDACTED]`.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replaceAll(pattern, "[REDACTED]");
  }
  out = out.replaceAll(GENERIC_ASSIGNMENT_PATTERN, "$1$2[REDACTED]");
  return out;
}

/**
 * Sanitize (strip zero-width chars + collapse whitespace) then redact secrets.
 * Used for all untrusted text before it enters the model context or review logs.
 *
 * @param text - Untrusted text to sanitize and redact.
 * @returns Sanitized text with secrets redacted.
 */
export function sanitizeForPrompt(text: string): string {
  return redactSecrets(sanitize(text));
}

/**
 * Truncate text to maxChars, preserving head and tail.
 *
 * @param text - Text to truncate.
 * @param maxChars - Maximum character count of the result.
 * @returns Truncated text with a `[...truncated...]` marker if shortened, or the original text if
 *   within the limit.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tag = "\n[...truncated...]\n";
  const available = Math.max(0, maxChars - tag.length);
  const headLength = Math.floor(available * 0.6);
  const tailLength = available - headLength;
  // slice(-0) returns the whole string, so guard against tailLength === 0
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  return `${text.slice(0, headLength)}${tag}${tail}`;
}

/**
 * Type guard: is this value a plain object (not array, not null)?
 *
 * @param value - Value to test.
 * @returns True if `value` is a plain object (type-narrowed to `Record<string, unknown>`).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
