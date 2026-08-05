---
"pi-permission-ai-guard": minor
---

Persist deny reason in audit records, expand secret redaction patterns, and tighten type safety.

**Deny reason audit persistence**: `DecisionRecord.model()` and `DecisionRecord.breaker()` now persist the sanitized deny reason in the `reason` field (deny-only; absent for allow/defer). `DecisionRecord.cacheHit()` receives the full `AuthorizerVerdict` instead of just the kind, so cached deny reasons are also recorded. Fixes an audit-visibility gap where operators could not determine why a command was denied without re-running the review.

**Secret redaction expansion and precision** (defense-in-depth layer): added patterns for GitHub (`ghp_`/`github_pat_`), GitLab (`glpat-`), Slack (`xox[bpoa]-`), Google (`AIza`), Stripe (`sk_live_`/`rk_live_`/`sk_prod_`), DigitalOcean (`dop_v1_`), Databricks (`dapi`), SendGrid (`SG.`), Atlassian (`ATATT3`), Alibaba (`LTAI`), npm (`npm_`), PyPI (`pypi-AgEI`); added `authorization` to the key=value assignment pattern; made PEM redaction multi-line safe (`[\s\S]*?`). Tightened existing patterns: AWS (11 prefixes, base32 charset, `\b`), Anthropic (min 40 chars), GitHub classic (exact 36), GitHub fine-grained (min 60), GitLab (optional CRC suffix), Stripe (`prod` variant), Databricks (optional `-N` suffix), Bearer (added `+`/`~` chars).

**Deny reason edge case fix**: `verdict.ts` now sanitizes first then falls back to `GENERIC_DENY_REASON`, so whitespace-only or zero-width-only reasons no longer produce empty deny reasons.

**Type safety and consistency**: `ModelCallContext.log` and `.requestId` tightened from `T | undefined` to non-null (both are always provided by the pipeline). Added `cacheLookup()` and `modelCallError()` factory functions with record types, matching the existing `shortCircuit()`/`modelReply()` pattern — all audit/debug payloads now go through typed factories. Tests updated to use event-name constants instead of hardcoded strings.

**Error/diagnostic redaction**: auth errors, model call errors, and empty-reply diagnostic messages are now sanitized via `sanitizeForPrompt` before being written to audit/debug logs.
