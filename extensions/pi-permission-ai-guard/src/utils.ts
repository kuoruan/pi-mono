/**
 * Shared prompt-sanitization, hashing, stringification, and record guards
 * used across modules.
 *
 * - NormalizeText: strip zero-width chars + collapse whitespace (anti-injection)
 * - NormalizeAndRedactText: normalize + redact secrets (for model context / logs)
 * - RedactSecrets: scrub common credential patterns
 * - TruncateMiddle: head+tail string truncation
 * - IsObjectRecord: type guard for non-array objects
 * - ShortHash: stable hash for cache keys / log correlation
 * - SafeStringify: JSON.stringify via try/catch (config snapshots, log data)
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
  // works even without normalizeText() having collapsed whitespace first.
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
 * Remove invisible characters that can obscure prompt-injection payloads.
 *
 * @param text - Text from which to remove zero-width characters.
 * @returns The text without zero-width characters.
 */
function stripZeroWidthChars(text: string): string {
  // The set covers the format characters that can deceive a reader:
  // zero-width joiner-ish forms (200B–200D, 2060, FEFF) plus the bidi
  // directional controls (202A–202E overrides and 2066–2069 isolates)
  // that visually reorder surrounding text — an RLO can make a command
  // read as its reverse in a prompt, a notify line, or the audit log.
  return text.replace(/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]+/gu, "");
}

/**
 * Truncate text to maxChars, preserving head and tail.
 *
 * @param text - Text to truncate in the middle.
 * @param maxChars - Maximum character count of the result.
 * @returns Truncated text keeping the head and tail with an explicit `[...truncated...]`
 *   marker, or the original text if within the limit. The marker spells the truncation out
 *   because transcript entries feed the model which must read them as truncation, and it stays
 *   single-line because every consumer wraps text into one-line fields.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tag = "[...truncated...]";
  const available = Math.max(0, maxChars - tag.length);
  const headLength = Math.floor(available * 0.6);
  const tailLength = available - headLength;
  // slice(-0) returns the whole string, so guard against tailLength === 0
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  return `${text.slice(0, headLength)}${tag}${tail}`;
}

/**
 * Type guard: is this value an object record (not array, not null)?
 *
 * @param value - Value to test.
 * @returns True if `value` is a non-array object (type-narrowed to `Record<string, unknown>`).
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Terminal control sequences and C0 controls: stripped from untrusted text
 * before it reaches prompt fields, notifications, or the review log — the
 * notify line is the one channel where model text reaches the operator's
 * terminal unescaped. CSI (`ESC [ params final-byte`) and BEL-terminated OSC
 * (`ESC ] … BEL`, e.g. OSC 8 hyperlinks) are removed whole; lone ESC and C0
 * controls (NUL, BEL, DEL, …) are removed individually, which alone suffices
 * to defuse every sequence — whatever is left is inert text.
 */
// Intentional: matching terminal control codes is this sanitizer's purpose,
// so the generic accidental-match rule is disabled on the pattern itself.
const STRIP_CONTROL_PATTERN =
  // oxlint-disable-next-line no-control-regex
  /\u001B\[[0-9;?]*[@-~]|\u001B\][^\u0007]*\u0007|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/g;

/**
 * Sanitize untrusted text before embedding it in prompts.
 *
 * Strips zero-width and bidi-directional characters (ZWSP, ZWNJ, ZWJ,
 * WJ, BOM, RLO/PDF, LRI/PDI isolates) that bypass `\s` matching, obscure
 * injection payloads, or visually reorder text, then collapses all
 * whitespace to single spaces and trims — preventing section header
 * injection via newlines.
 *
 * @param text - Untrusted text to normalize.
 * @returns Sanitized text with zero-width and terminal control chars removed, whitespace collapsed.
 */
export function normalizeText(text: string): string {
  return stripZeroWidthChars(text).replace(STRIP_CONTROL_PATTERN, "").replace(/\s+/g, " ").trim();
}

/**
 * Redact common secret/credential patterns from text, replacing values with
 * `[REDACTED]`. Idempotent: redacting an already-redacted string is a no-op
 * (the placeholder contains no credential-shaped value).
 *
 * Applied AFTER normalizeText() in prompt building, so whitespace is already
 * collapsed and zero-width chars stripped.
 *
 * @param text - Text to redact secrets from.
 * @returns Text with credential patterns replaced by `[REDACTED]`.
 *   Safe to call on multi-line input: PEM patterns use `[\s\S]*?` to match
 *   across newlines. When used via {@link normalizeAndRedactText},
 *   normalizeText() runs
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
 * Normalize (strip zero-width chars + collapse whitespace) then redact secrets.
 * Used for all untrusted text before it enters the model context or review logs.
 *
 * @param text - Untrusted text to normalize and redact.
 * @returns Normalized text with secrets redacted.
 */
export function normalizeAndRedactText(text: string): string {
  return redactSecrets(normalizeText(text));
}

/**
 * Serialize untrusted action text for an inline prompt field without losing
 * shell-significant whitespace. JSON escaping prevents the value from
 * creating prompt sections while preserving newlines, heredocs, and quoting.
 *
 * @param text - Untrusted action text to redact and serialize.
 * @returns A redacted JSON string literal safe to embed in one prompt field.
 */
export function encodeActionTextForPrompt(text: string): string {
  return JSON.stringify(redactSecrets(stripZeroWidthChars(text)));
}

/**
 * Fast deterministic hash to shorten long strings for cache/identity keys.
 *
 * Copied from pi-ai's internal `utils/hash.ts` (not re-exported from the
 * package root). Two independent 32-bit Math.imul hashes (cypherCB),
 * finalized and combined as base36.
 *
 * @param str - The string to hash.
 * @returns A short base36 hash of the input string.
 */
export function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/**
 * Normalize an absent (undefined) or empty-string field to `null`.
 *
 * @param value - The field value to normalize.
 * @returns The value when non-empty, else `null`.
 */
export function normalizeEmpty(value: string | undefined | null): string | null {
  return value && value.length > 0 ? value : null;
}

/**
 * Extract text from a message's content (string or array of blocks).
 *
 * @param content - The message content (string or array of blocks).
 * @returns The concatenated text from the content, or an empty string if none.
 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (!isObjectRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Glob match: `*` matches any character sequence, other chars match literally.
 *
 * @param pattern - The glob pattern (with `*` wildcards).
 * @param text - The text to test against.
 * @returns True if `text` matches the glob `pattern`.
 */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return pattern === text;
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(text);
}

/**
 * Safely stringify a value to JSON, guarding against cycles or BigInt.
 * Returns "[unstringifiable]" on failure instead of throwing.
 *
 * @param value - The value to stringify.
 * @returns The JSON string, or `"[unstringifiable]"` if stringification threw.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unstringifiable]";
  }
}
