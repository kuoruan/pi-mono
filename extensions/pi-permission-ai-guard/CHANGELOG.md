# pi-permission-ai-guard

## 0.3.0

### Minor Changes

- 737fd69: Refactor: rename sanitize→normalizeText, sanitizeForPrompt→normalizeAndRedactText,
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

## 0.2.0

### Minor Changes

- bd28cc0: Persist deny reason in audit records, expand secret redaction patterns, and tighten type safety.

  **Deny reason audit persistence**: `DecisionRecord.model()` and `DecisionRecord.breaker()` now persist the sanitized deny reason in the `reason` field (deny-only; absent for allow/defer). `DecisionRecord.cacheHit()` receives the full `AuthorizerVerdict` instead of just the kind, so cached deny reasons are also recorded. Fixes an audit-visibility gap where operators could not determine why a command was denied without re-running the review.

  **Secret redaction expansion and precision** (defense-in-depth layer): added patterns for GitHub (`ghp_`/`github_pat_`), GitLab (`glpat-`), Slack (`xox[bpoa]-`), Google (`AIza`), Stripe (`sk_live_`/`rk_live_`/`sk_prod_`), DigitalOcean (`dop_v1_`), Databricks (`dapi`), SendGrid (`SG.`), Atlassian (`ATATT3`), Alibaba (`LTAI`), npm (`npm_`), PyPI (`pypi-AgEI`); added `authorization` to the key=value assignment pattern; made PEM redaction multi-line safe (`[\s\S]*?`). Tightened existing patterns: AWS (11 prefixes, base32 charset, `\b`), Anthropic (min 40 chars), GitHub classic (exact 36), GitHub fine-grained (min 60), GitLab (optional CRC suffix), Stripe (`prod` variant), Databricks (optional `-N` suffix), Bearer (added `+`/`~` chars).

  **Deny reason edge case fix**: `verdict.ts` now sanitizes first then falls back to `GENERIC_DENY_REASON`, so whitespace-only or zero-width-only reasons no longer produce empty deny reasons.

  **Type safety and consistency**: `ModelCallContext.log` and `.requestId` tightened from `T | undefined` to non-null (both are always provided by the pipeline). Added `cacheLookup()` and `modelCallError()` factory functions with record types, matching the existing `shortCircuit()`/`modelReply()` pattern — all audit/debug payloads now go through typed factories. Tests updated to use event-name constants instead of hardcoded strings.

  **Error/diagnostic redaction**: auth errors, model call errors, and empty-reply diagnostic messages are now sanitized via `sanitizeForPrompt` before being written to audit/debug logs.

### Patch Changes

- b6807f4: Tighten SAFETY_RULES: network rule precision, shell injection coverage, intent tri-state, and verdict contract.

  **Network rule precision** (from production log analysis):

  - "Data exfiltration (curl/wget to external endpoints)" → "Sending secrets, local data, or command output to external endpoints (curl/wget POST/upload)" — distinguishes GET from POST/upload
  - "Network services accepting external connections" → "Starting services/listeners reachable by external clients (nc -l, python -m http.server, docker -p 0.0.0.0:...)" — distinguishes outbound connections from local listeners
  - New "DENY — Unless" entry: "Read-only outbound fetch/navigation (browser navigation, web_fetch, curl/wget GET)" — allow with matching user intent, otherwise defer

  **Shell injection coverage** (from code review):

  - Chain rule now also covers command substitutions ($(), backticks), subshells (()), process substitutions (<()), and heredocs — not just &&/||/|/;
  - Any dangerous nested command controls the verdict

  **Intent tri-state** (from code review):

  - Replaced ambiguous "uncertain about intent → defer" with explicit three-state: clear matching intent → allow; clear absence of intent → deny unless category states otherwise; insufficient evidence → defer
  - Clarified "(none found)" means no retained evidence (bounded transcript window), not clear absence — clear-absence deny applies only when retained intent positively shows the action is outside scope
  - Deletion operations tightened: "require explicit matching intent; otherwise deny" — no longer ambiguous whether "without intent" means clear absence or insufficient evidence

  **Decision precedence** (from code review):

  - New section: "DENY — Always beats DENY — Unless beats ALLOW"
  - ALLOW read-only now explicitly excludes reading, copying, or exposing credentials/secrets (resolves cat ~/.ssh/id_rsa ambiguity)

  **Secrets/Security weakening clarity**:

  - "Secrets/credentials (.env, ~/.ssh, keys, tokens)" → "Secrets/credentials — reading, copying, modifying, or exposing secret files and values (.env, ~/.ssh, keys, tokens, ~/.bash_history)"
  - "SSH keys, cron/systemd" → "modifying SSH authorized_keys, creating cron/systemd tasks"
  - "Git force-push or branch delete to" → "Git force-push to, or deletion of"

  **Verdict contract** (from production log analysis):

  - Replaced ambiguous bullet descriptions with three compact JSON examples (allow/deny/defer)
  - deny: reason + riskLevel both required; defer: reason required, riskLevel optional; allow: omit both
  - "never use empty strings; omit fields that do not apply"

  **Review trigger**: "Assess the above" → "Assess the permission request above and respond with your JSON verdict"

- a153759: Tighten verdict output contract: require riskLevel for deny, require non-empty reason for deny and defer.

  The model-facing verdict contract now uses explicit conditional field rules
  instead of ambiguous "optional" bullets:

  - allow: omit reason and riskLevel
  - deny: reason (unsafe action + safer alternative) and riskLevel are both required
  - defer: reason (what is unclear or what human confirmation is needed) is required;
    riskLevel optional

  Also adds an explicit instruction to omit fields that do not apply and never
  emit empty-string fields, addressing the observed empty defer reason and
  absent deny riskLevel in production logs.

  Internal contract unchanged: `reason` remains deny-only in the audit record;
  `deferReason` remains the classified machine reason. The model's defer
  explanation continues to be available in `rawReply` for `model-defer` outcomes.

## 0.1.1

### Patch Changes

- ae36db9: chore: bump to v0.1.1
