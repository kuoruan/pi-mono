---
"pi-permission-ai-guard": minor
---

Refactor: rename sanitize→normalizeText, sanitizeForPrompt→normalizeAndRedactText,
truncate→truncateMiddle, isRecord→isObjectRecord for clarity. Split
encodeActionTextForPrompt from normalizeAndRedactText to preserve
shell-significant whitespace (heredocs, newlines) in bash action text via
JSON encoding.

Extract review-request.ts: single seam for permission details → prompt
context + cache material. Cache now includes actionText and
canonicalBoundary, preventing verdict reuse across distinct commands.

Security: transcript-stripper no longer treats compaction summaries as
trusted user intent — they may contain model/tool output and must never
become authorization signals.

SAFETY_RULES: universal principle-based rewrite (~1100 tokens, down from
~1565). Removes environment-specific paths, uses semantic categories with
sparse illustrative examples. Restores external-code-execution variants
(wget|bash, pip/npm install from URL, npx/pnpm dlx, deno/bun run) and
setuid (chmod +s) as explicit DENY-Always anchors. Keeps uncertain→defer
calibration, read-only vs interaction distinction, and build-script allow.
