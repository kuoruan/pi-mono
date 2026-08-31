# pi-permission-ai-guard

## 0.8.2

### Patch Changes

- bd6baee: Harden the audit and sanitize surfaces found by the full-package review.

  - The decision record's `target` field now goes through the same normalize-and-redact as every other untrusted field — a credential inside a reviewed command no longer lands unredacted in the always-on review log.
  - The sanitizer strips bidi directional controls (U+202A–202E, U+2066–2069): an RLO can make a command visually read as its reverse in a prompt, notify line, or audit record.
  - The registration-failure notice drops its structural colon (the TUI's own level prefix would double it); a skeleton test now scans every static notify literal so the colon-free shape cannot drift back.

- 7916ed0: Classify provider errors resolved as non-thrown replies as `call-failed`.

  pi-ai surfaces some provider failures (rate limits, proxy/WAF blocks) as responses with `stopReason: "error"` rather than thrown errors — these previously landed in the `empty-reply` bucket, mixing infrastructure failures with the genuine model-silence pathology the empty-reply retry targets. The retry still fires for fast error-resolved replies (transient errors deserve it); only the classification moves, so the decision log and the machinery-defer notice name the cause honestly — 405 storms now read as `call-failed`, and `empty-reply` counts only real model silence.

- edf600b: Single-source the pre-call machinery-failure kinds: the four kind values (`model-unresolved`, `auth-failed`, `transcript-error`, `no-target`) live as one object constant in the new machinery-failure taxonomy module (which also owns the unified `MachineryFailureKind` union), every pipeline spelling site references the constant, `shortCircuit`'s reason is typed by the pre-call kind union, and `ask.ts` derives its `no-target` discriminant from the same value.
- 0ef2bf3: Track pi-permission-system 29: the peer range accepts `^27.1.1 || ^28.0.0 || ^29.0.0`. v29 removes the deprecated process-root service slot — APIs this extension never referenced — so the breaking removal is a no-op; the suite passes under all three resolved majors. Development resolves `^29.0.0`.

## 0.8.1

### Patch Changes

- 5c541c0: Track pi-permission-system 28 with a dual-version peer range.

  - The peer range accepts `^27.1.1 || ^28.0.0`: the API surface this extension consumes (the Authorizer seam, verdict types, session-keyed service registration) is identical across the two majors, verified by the full suite under both resolved versions.
  - v28's breaking change — decision attribution (`authorizer_allowed`/`authorizer_denied` resolutions, the agent-side refusal render naming the deciding link) — sits upstream of this extension's interface and needs no code here. The effect is a gain: a link deny is now rendered to the agent as "the 'ai-guard' authorizer denied this call" plus our reason, so the corrective reason reads as policy rather than as the user's instruction.
  - Development and tests resolve `^28.0.0`.

## 0.8.0

### Minor Changes

- f7da78d: BREAKING: adopt pi-permission-system v27; the v26 peer range is dropped — consumers must upgrade.

  - Session-keyed permission services: the link registers once per session on the node's own service, with the `permissions:ready` payload as the official session-id source; hosts without a session id keep deferring (see ADR 0001).
  - One extension instance per session node (each node has its own lifecycle) — subagent children register their own link instead of reusing the parent's.

- 41098f8: Give the circuit breaker an operator-visible trip and a manual reset.

  - The total tier's first trip notifies the operator once per trip epoch: `circuit breaker tripped — total tier reached, blocking all reviews until /ai-guard breaker reset or restart`. Until now a total-tier trip was silent — the operator only discovered it from mysteriously denied commands (a heavy session with a deny-leaning reviewer burns the model-deny budget by volume, not failure). The notice rides the ambient channel at error grade: `notifyLevel` `off` silences it and consumes the once-per-epoch notice; the `error` threshold keeps it visible while silencing everything else.
  - `/ai-guard breaker reset` (also the settings menu's last entry) clears both tiers. A pure counter reset: the verdict cache, mode, notifyLevel, and every session override survive it, and the confirmation notice says so. A session restart clears the breaker either way.
  - Consecutive-tier trips stay quiet (they self-heal on the next allow; their per-ask machinery notices already speak on the defer lanes).

- 019de3b: Reviewer defers carry a `lean` — the reviewer's directional inclination — and the mode ladder routes on it.

  - The reviewer's defer output format includes an optional `lean: "allow" | "deny"` (omitted = neutral; the prompt anchors both directions: deny-lean names a visible danger pattern, allow-lean names a benign action with an unclear authorization link).
  - `lenient` passes benign- and neutral-leaned defers but asks on danger-leaned ones (a deny-leaning doubt is an active alarm); every other mode treats the lean states as the suspicion order dictates — lean only moves a defer across the ask↔allow boundary, never into or out of the deny band.
  - Lean is a routing signal only — never shown in dialogs or notify lines (anti-anchoring: the ask is the operator's judgment moment). It lives in the `ai_guard.decision` audit record (`lean: "allow" | "deny" | null`).
  - Benign-leaned passes are silent (the model's own inclination confirmed; allows never notify) and never cached (defers are never stored — identical asks re-review fresh).
  - Invalid lean values degrade to neutral; a defer is never invalidated by its lean. The breaker counts the model's verdict (a defer feeds no tier).

- 3460b98: Add a `maxTokens` config option (default 4096) — the reviewer reply budget now leaves reasoning upstreams enough headroom that a thinking block can finish before the verdict JSON, instead of truncating mid-think into the empty-reply machinery failure.
- c6b3911: Add a four-mode leniency ladder — `strict`, `default`, `lenient`, `permissive` — deciding who adjudicates the reviewer's non-allow verdicts.

  - `strict`: the reviewer's allow is the only pass (fail-closed automation).
  - `default`: you judge every flag but hard danger — soft denials and every unresolved doubt ask you.
  - `lenient`: only the reviewer's active alarms ask you (soft denials and deny-leaning doubts); benign and neutral doubts pass.
  - `permissive`: only hard-tier denials block, and each such block notifies the operator.

  Hard-tier denials (riskLevel high|critical, or missing) stay terminal in every mode. Reviewer machinery failures never map to allow: they deny under `strict` and `permissive`, defer under the other two, and every forced deferral announces its classified cause to the operator.

  The ctrl+alt+g cycle visits `default → lenient → permissive`; only `strict` is set explicitly.

- 2141200: Make operator notices honest about outcomes, complete in content, and consistent in shape.

  - A model deny that holds or escalates notifies in every mode: v27 renders no dialog for denials (the reason goes to the agent and the audit log only), so the notify line is the operator's only copy. A mode-softened deny ends `— asking you instead`; a deny that holds needs no tail. `permissive` swallows soft denies whole (zero-interruption contract) — only its hard-tier blocks notify.
  - Model reasons and clarifications go out whole in notify lines, with a 200-char defensive ceiling (`NOTIFY_REASON_CEILING`) that bounds the display when a model runs long; the prompt anchors reasons at ~150 characters (a concise sentence), and the audit record keeps the full text either way.
  - The reviewer prompt binds reason to verdict: a deny reason must state what makes the request dangerous; an assessment that concludes the request is safe must be an `allow`.
  - Truncation markers are single-line everywhere (`[...truncated...]`, no embedded newlines) — notify lines never break into multi-line artifacts, and transcript entries keep the stripper's single-line doctrine.
  - Notify copy follows one skeleton (event sentence + em-dash consequence + parenthesized qualifier; state echoes stay `key = value (source)`), and the save-success line stays within it: the shadow-layer fact lives in the README (a saved layer can still be shadowed by a higher-precedence one).

- 61c0530: Centralize the notify seam and add an ambient-notify threshold.

  - All notify traffic routes through one session seam: the `[ai-guard]` prefix, the disposed-runner guard, and the level gate live in a single place — copy writers emit bare messages and no call site can forget the prefix or crash the verdict path. Command feedback (`/ai-guard` answers) rides the same primitive ungated.
  - New `notifyLevel` config field (`info | warning | error | off`, default `info`) gates ambient (review-loop) notices by threshold: `warning` silences the `reviewer asks` mirror, `error` keeps only the total-tier breaker trip (the one ambient error line), `off` silences every ambient line. Command feedback is never gated — silence on a typed command reads as breakage. A non-default value renders a footer fragment (e.g. `off · lenient (session)`), so a silenced pane stays visible.
  - `notifyLevel` is also a `/ai-guard` runtime setting (picker entry, direct form, session-scoped override that survives resume; `ctrl+alt+g` stays mode-only).
  - Guard-absent errors ride the ungated feedback channel at error grade: a fail-safe config start (no auto-review), a failed authorizer registration, and a stale registration surviving disposal each notify the operator directly — the guard being absent or mis-slotted must never hide behind a level threshold or a console log.

- cc95814: Track pi-permission-system 27.1 and teach the surface matcher the directional path families.

  - Dependency floor raised to `^27.1.1`. The 27.1 additions are compile-compatible (optional `floorExemption` audit field; the prompt payload's `kind` stays coarse), so no code change was required for the upgrade itself.
  - Surface matching now knows the read/write capability axis: `path` and `external_directory` have `_read`/`_write` directional members that a proven-direction access routes to. Four granularities: the bare family (`"path"`) reviews both directions plus direction-unknown access; a member glob (`"path_*"`) reviews proven-direction access only; a directional member (`"path_read"`) reviews exactly that direction; a family exclude (`"!path"`) withholds its directional members too. A `_read` suffix over any other name stays its own surface.

- c46418f: Add a `/ai-guard` runtime settings command: a mode picker with per-mode descriptions, a ctrl+alt+g shortcut cycling `default → lenient → permissive`, and save actions that persist the effective config (every field, session overrides included) into the global or project config — in-place JSONC leaf edits that preserve comments and formatting, refused for untrusted projects. Session overrides persist into pi's session file (custom entries, never LLM context) and restore on resume. The footer renders only deviations from the `default` baseline, with `permissive` in warning red.
- 2cad5a6: Retry upstream failures once per mechanism per review, budgeted inside `timeoutMs` (the total-budget promise — a review never exceeds one timeout window).

  - Provider errors (408/409/429/5xx and connection-level failures, per pi-ai's classifier, backoff and `retry-after` honored) retry inside pi-ai's provider layer; the timeout signal spans every attempt, so retries can never outlive the window.
  - Empty replies (a 200 with no usable text — an always-thinking upstream can spend the whole budget on reasoning) retry at the review layer, but only when the first attempt consumed less than half the window; the retry's budget is the remaining time, and it carries no provider-layer retry of its own — three requests is the hard ceiling per review.
  - The decision record gains `attempts: 2` on retried reviews; `latencyMs` is cumulative across attempts.

### Patch Changes

- 344c9e4: Restructure SAFETY_RULES: split fused entries into distinct concepts (Visible Evidence, Network & Browser, Bounded Load Tests, Loopback Servers), extract the fetch-to-inspect carve-out from External Code Execution, and anchor regenerable build artifacts and obfuscated-payload examples.
- 55030a3: Reclassify host shutdown/reboot from DENY-Always (Persistent System Changes) to its own intent-gated DENY-Unless entry, so an explicitly authorized shutdown or reboot is allowed instead of being denied regardless of intent.

## 0.7.0

### Minor Changes

- e22c364: Drop pre-26.0 support (peer range now `^26.0.0`) and read the structured `PromptPayload` directly via a `buildAskContext` projection, giving the review model `kind`-dispatched facts it previously did not.

### Patch Changes

- d90ed7e: Fix a parser edge case where a malformed verdict reply could be overridden by an unrelated allow example in the model's reasoning.

## 0.6.0

### Minor Changes

- e0d2036: Support pi-permission-system 26.0's structured prompt payload while keeping legacy message compatibility. `buildActionText` reads the bash full command from `payload.evidence` (the `full command` entry, present when it differs from the sub-command) on 26.0+ hosts, and falls back to parsing the legacy `message` framing on older hosts, so the `>=20.10.0` peer range still holds. Bump `@gotgenes/pi-permission-system` devDependency to ^26.0.0.

## 0.5.0

### Minor Changes

- f773889: SAFETY_RULES: sharpen tier fallbacks, intent routing, and category precedence.

  - **DENY — Unless heading**: drop the misleading "(Requires clear, matching user intent)" parenthetical; each entry now declares its own fallback (DENY/DEFER), consistent with the three-tier principle.
  - **Category Precedence (new General Rule)**: a single action matching multiple categories applies the strictest tier; Secrets & Credentials overrides any read-only or diagnostic category that would expose them. Fixes a gap where `ps`/`ss`/`lsof` exposing tokens, or `cat .env` as a CWD read, could be mis-allowed.
  - **Intent routing restored**: Environment Mutations, External Publishing, and MCP/Skill/Tool Side-Effects default to DEFER (not DENY) when intent is absent, aligning with "Uncertain → DEFER" and the General Rule's `otherwise → DEFER`.
  - **External Exposure / loopback**: outbound connections are no longer blanket-ALLOW (contradicted intent-gated network observation); they route under Network & Browser. Loopback dev/test servers are ALLOW only with an explicit loopback binding (`--host 127.0.0.1`/`localhost`/`[::1]` or a known-loopback-default framework); unexpressed/uncertain bindings DEFER (e.g. `python -m http.server` defaults to 0.0.0.0).
  - **Page-script classification**: split the over-broad "extractions" — visible DOM inspection is ALLOW (with intent); reading credentials/session/auth state/cookies/localStorage/private app state follows Secrets & Credentials / Sensitive-Data Egress; DOM mutations are DENY — Unless; remote fetch/run is DENY — Always.
  - **New DENY — Always categories**: Resource Abuse/DoS (unbounded/system resource exhaustion, with bounded load tests carved out as intent-sensitive); `.git/hooks`/`.git/config`/`.gitmodules` code-exec added to Destructive VCS; shutdown/reboot folded into Persistent System Changes.
  - **Removed**: Self-Modification (redundant with intent-gated writes + System Tampering), Database/Service Writes and Container/Orchestration (overlapped bash chain eval + MCP side-effects).
  - **Privilege-escalation divide made explicit**: persistent privileged entry points (setuid, sudoers, authorized_keys) are DENY — Always; one-time `sudo` for a single visible scoped command is DENY — Unless.
  - **Wording**: simplified Unknown Commands ("DEFER by default; DENY only if behavior matches a DENY category"), restored the Sensitive-Data Egress anti-scope-creep clause, added obfuscated/encoded-payload handling, narrowed Resource Abuse examples.

CONTEXT.md principle 7: marked "intent matching is not required" as relocated to the Intent-Based Routing rule (protective meaning preserved at the routing layer; the entry-level string was misreadable).

### Patch Changes

- 2a19422: Align `ModelCallAuth` with upstream pi-ai types and bump dev/runtime deps.

  - `ModelCallAuth` is now `Pick<SimpleStreamOptions, "apiKey" | "headers">`, replacing a hand-written `Record<string, string>` whose header type was too narrow (pi-ai 0.84 widened provider headers to `string | null`). This fixes a type error introduced by the `@earendil-works/pi-ai` 0.83 → 0.84 upgrade and keeps the auth type auto-aligned with future upstream changes.
  - Bump dev dependencies to latest: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 0.83 → 0.84.1, `@gotgenes/pi-permission-system` 24.0.0 → 25.2.0 (adds consulted-chain-link review-log recording and fixes a false "unregistered link" report for delegated subagent chains), `oxfmt` 0.61 → 0.63, `oxlint` 1.77 → 1.78, `memfs` 4.66 → 4.68. No public API or runtime behavior change.

## 0.4.0

### Minor Changes

- 8a3f1d7: Rename audit fields: `deferReason` (enum classification) → `deferKind`, add `deferReason` (string) for model-generated defer explanation. The `reason` field now persists on both deny and model-defer verdicts.

Extract `normalizeReason()` in verdict.ts to unify deny/defer reason sanitization (empty/whitespace/non-string → undefined).

SAFETY_RULES: add "treat explicit flags as evidence" anchor (fixes npx --no-install false positive) and "creating a reachable endpoint, not connecting to one" (fixes localhost navigation false positive). Simplify verdict reason placeholders.

## 0.3.0

### Minor Changes

- 737fd69: Refactor: rename sanitize→normalizeText, sanitizeForPrompt→normalizeAndRedactText, truncate→truncateMiddle, isRecord→isObjectRecord for clarity. Split encodeActionTextForPrompt from normalizeAndRedactText to preserve shell-significant whitespace (heredocs, newlines) in bash action text via JSON encoding.

Extract review-request.ts: single seam for permission details → prompt context + cache material. Cache now includes actionText and canonicalBoundary, preventing verdict reuse across distinct commands.

Security: transcript-stripper no longer treats compaction summaries as trusted user intent — they may contain model/tool output and must never become authorization signals.

SAFETY_RULES: universal principle-based rewrite (~1100 tokens, down from ~1565). Removes environment-specific paths, uses semantic categories with sparse illustrative examples. Restores external-code-execution variants (wget|bash, pip/npm install from URL, npx/pnpm dlx, deno/bun run) and setuid (chmod +s) as explicit DENY-Always anchors. Keeps uncertain→defer calibration, read-only vs interaction distinction, and build-script allow.

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

The model-facing verdict contract now uses explicit conditional field rules instead of ambiguous "optional" bullets:

- allow: omit reason and riskLevel
- deny: reason (unsafe action + safer alternative) and riskLevel are both required
- defer: reason (what is unclear or what human confirmation is needed) is required; riskLevel optional

Also adds an explicit instruction to omit fields that do not apply and never emit empty-string fields, addressing the observed empty defer reason and absent deny riskLevel in production logs.

Internal contract unchanged: `reason` remains deny-only in the audit record; `deferReason` remains the classified machine reason. The model's defer explanation continues to be available in `rawReply` for `model-defer` outcomes.

## 0.1.1

### Patch Changes

- ae36db9: chore: bump to v0.1.1
