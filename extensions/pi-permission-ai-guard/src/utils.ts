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
  // AWS access key id (base32, 16 chars after prefix). Prefixes per gitleaks:
  // A3T/AKIA/AGPA/AIDA/AROA/AIPA/ANPA/ANVA/ABIA/ACCA/ASIA.
  /\b(?:A3T|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA|ASIA)[A-Z2-7]{16}\b/g,
  // Anthropic API key (sk-ant-api03- or sk-ant-admin01- + ≥40 chars).
  // Min 40 chars after sk-ant- per Quell (real keys are 93+AA, but partial
  // keys still warrant redaction).
  /sk-ant-[a-zA-Z0-9_-]{40,}/g,
  // Generic OpenAI / "sk-" keys (require ≥20 chars after sk- to avoid matching "skip").
  // Must come AFTER the sk-ant- pattern so Anthropic keys are caught first.
  /sk-[a-zA-Z0-9]{20,}/g,
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ (exactly 36 chars per GitHub spec).
  /gh[pousr]_[A-Za-z0-9]{36}/g,
  // GitHub fine-grained PAT (github_pat_ + ≥60 chars, per Quell).
  /github_pat_[A-Za-z0-9_]{60,}/g,
  // GitLab personal access token (glpat- + ≥20 chars, optional .{9} CRC suffix).
  /glpat-[A-Za-z0-9_-]{20,}(?:\.[0-9a-z]{9})?/g,
  // Slack tokens (xox[bpoa]- + ≥12 chars, or xapp- structured).
  /xox[bpoa]-[A-Za-z0-9-]{12,}/g,
  // Google API key (AIza + 35 chars).
  /AIza[0-9A-Za-z_-]{35}/g,
  // Stripe secret/restricted keys (sk/rk + live/test/prod + ≥24 chars).
  /[sr]k_(?:live|test|prod)_[A-Za-z0-9]{24,}/g,
  // DigitalOcean tokens (dop_v1_/doo_v1_/dor_v1_ + 64 hex).
  /do[pr]_v1_[a-f0-9]{64}/g,
  // Databricks personal access token (dapi + 32 hex, optional -N suffix).
  /dapi[a-f0-9]{32}(?:-\d)?/g,
  // SendGrid API key (SG. + 22 base64 + optional .suffix).
  /SG\.[A-Za-z0-9_-]{22}(?:\.[A-Za-z0-9_-]+)?/g,
  // Atlassian API token (ATATT3 + ~186 chars).
  /ATATT3[A-Za-z0-9_\-=]{186}/g,
  // Alibaba Cloud access key id (LTAI + 20 alnum).
  /LTAI[A-Za-z0-9]{20}/g,
  // npm publish token (npm_ + 36 chars).
  /npm_[A-Za-z0-9]{36}/g,
  // PyPI upload token (pypi-AgEI + ≥100 chars).
  /pypi-AgEI[A-Za-z0-9_-]{100,}/g,
  // Bearer tokens (require ≥8 chars after; \s or : separator to cover
  // both "Bearer <token>" and "Bearer:<token>" forms).
  /bearer[\s:]+[A-Za-z0-9._~+/-]{8,}/gi,
  // PEM private key blocks. [\s\S]*? matches across newlines so redactSecrets
  // works even without sanitize() having collapsed whitespace first.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Key=value assignments: preserve the key name, redact only the value.
 * The value may be bare (\S+), double-quoted, or single-quoted — quoted forms
 * are matched first so a value containing spaces (e.g. password="my secret")
 * is redacted whole instead of leaving residue after the opening quote.
 */
const GENERIC_ASSIGNMENT_PATTERN =
  /(password|passwd|passphrase|token|secret|api_key|apikey|credential|authorization|private_key|privatekey|aws_secret_access_key|aws_access_key_id)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

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
 *   Safe to call on multi-line input: PEM patterns use `[\s\S]*?` to match
 *   across newlines. When used via {@link sanitizeForPrompt}, sanitize() runs
 *   first (strips zero-width chars, collapses whitespace) — but
 *   `redactSecrets` alone also handles multi-line PEM blocks.
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
