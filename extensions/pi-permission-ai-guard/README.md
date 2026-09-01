# pi-permission-ai-guard

A [Pi](https://github.com/earendil-works/pi) extension that reviews permission asks with a light model, using a **token-optimized stripped transcript**.

It is a consumer of [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages): it registers an `"ai-guard"` link in its authorizer chain, reviewing `ask`-level permission requests on the configured surfaces (bash, mcp, skill).

## Why

Each model review call sends **only stripped context** (user messages + tool call names), not the full transcript. This substantially reduces token consumption by discarding assistant text and tool results — the token-heaviest parts of a transcript — with minimal impact on verdict quality.

Two structural choices distinguish the reviewer from a plain classifier: the verdict **lean never feeds back** into the model's own context (each review is stateless — an agent cannot anchor the reviewer toward its own history), and both ladder extremes are **lean-inert** (`strict` denies every non-allow, `permissive` passes everything short of a hard deny or a reviewer failure — the lean only routes the middle rungs). These are deliberate mitigations for the classifier drift documented in Anthropic's [auto-mode writeup](https://www.anthropic.com/engineering/claude-code-auto-mode), where consent-shaped evidence in history was the top failure mode — structure instead of prompt-tuning.

## How it works

The reviewer runs a short, cheap decision on each ask and defers at the first miss:

1. Surface match: the ask's surface is in `surfaces` (otherwise defer).
2. Extract the review target (the value being authorized).
3. Policy gate: query the deterministic engine at gate parity — if the policy already says `allow` or `deny`, defer. This link only adds value when the engine is undecided (`ask`).
4. Circuit breaker: a tripped breaker short-circuits without a model call.
5. Resolve the model (fails fast on a config error).
6. Strip transcript (token-optimized): the stripped transcript feeds both the verdict cache's context fingerprint and the model review prompt.
7. Verdict cache lookup: a repeated ask in a stable conversation hits the cache and skips the model.
8. Resolve auth — after the cache, so a cached repeat ask survives an auth flap.
9. Build prompt (redaction happens here — credentials in the command/intent are scrubbed before the prompt is built).
10. Model review: JSON verdict.
11. Record the verdict into the breaker counters and cache.

Fail-safe by construction: a missing model, invalid config, model timeout, unparseable reply, or an unsure verdict all resolve to `defer`. This list is representative, not exhaustive — any unexpected error path also defers. Deferring means the ask falls through to the normal permission prompt.

Upstream failures retry once per mechanism, budgeted inside `timeoutMs`: provider errors retry in pi-ai's provider layer; an empty reply retries at the review layer when at least half the window remains. Three requests is the hard ceiling; `attempts: 2` on the decision record marks a retried review.

## Transcript stripping

| Message type              | Handling                   | Why                                                                 |
| ------------------------- | -------------------------- | ------------------------------------------------------------------- |
| user message              | Keep (truncated)           | Trusted authorization signal                                        |
| compaction/branch summary | **Delete**                 | May contain model output; must never become an authorization signal |
| assistant text            | **Delete**                 | Untrusted (agent can rationalize)                                   |
| tool call                 | Keep name + truncated args | Show what agent did                                                 |
| tool result               | **Delete**                 | Untrusted (injection entry), token-heaviest                         |
| ask_user_question result  | Keep (trusted intent)      | User's structured answers                                           |

## Install

**Prerequisite:** [`pi-permission-system`](https://github.com/gotgenes/pi-packages) >= 27.1.1 installed and active — this extension is a link in its authorizer chain and does nothing on its own.

```bash
pi install npm:pi-permission-ai-guard
```

Or add to `settings.json`:

```json
{ "packages": ["npm:pi-permission-ai-guard"] }
```

## Configure

Two config files are involved: pi-permission-system's config names the chain link, and this extension's config declares the model and review behavior. This extension reads `config.jsonc` or `config.json` (JSONC — comments and trailing commas are fine); when both exist, `config.jsonc` wins.

1. In **pi-permission-system** config, name the link in `authorizerChain`:

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-system/config.json
   { "authorizerChain": ["ai-guard"] }
   ```

2. In **this** extension's config, declare the model and review behavior:

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-ai-guard/config.jsonc
   {
     "provider": "anthropic",
     "model": "claude-haiku-4-5",
     "reasoning": "off",
     "timeoutMs": 15000,
     "transcript": {
       "maxUserMessages": 5,
       "maxToolCalls": 10,
       "maxCharsPerEntry": 1000,
     },
     "surfaces": ["bash", "mcp", "skill"],
   }
   ```

See [`config/config.example.json`](config/config.example.json) for a complete example.

> **Where to put hard-deny rules:** secrets, dangerous commands, and safe auto-allow patterns belong in **pi-permission-system's** rule config (deny / allow rules), not in this extension. The AI-guard link only runs the model when the deterministic engine is undecided (`ask`) — it queries the engine at gate parity and defers whenever the engine already decided `allow` or `deny`. Configure `.env`/`~/.ssh`/`rm -rf` style blocks as pi-permission-system rules so the chain (and this link) honors them without a model call.

## Configuration

| Field            | Type                                                                    | Default                                   | Description                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`       | string                                                                  | required                                  | Model provider (e.g. `anthropic`)                                                                                                                                                                                           |
| `model`          | string                                                                  | required                                  | Model id (e.g. `claude-haiku-4-5`)                                                                                                                                                                                          |
| `reasoning`      | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"off"`                                   | Thinking level (pi-ai `ModelThinkingLevel`); `off` = disabled                                                                                                                                                               |
| `timeoutMs`      | integer                                                                 | `15000`                                   | Model-call timeout (ms)                                                                                                                                                                                                     |
| `maxTokens`      | integer                                                                 | `4096`                                    | Reviewer reply budget; thinking blocks count against it on reasoning upstreams                                                                                                                                              |
| `transcript`     | object                                                                  | see below                                 | Transcript stripping config (see below)                                                                                                                                                                                     |
| `surfaces`       | string[]                                                                | `["bash","mcp","skill"]`                  | Surfaces to review; glob patterns (`*`, `ns:*`, `*:bar`); `!` excludes. Path-family granularity: `path` = whole family, `path_*` = proven-direction access only, `path_read` = one direction, `!path` = family-wide exclude |
| `instructions`   | string\|null                                                            | `null`                                    | Custom safety rules (replaces defaults; null = built-in)                                                                                                                                                                    |
| `mode`           | `"strict"\|"default"\|"lenient"\|"permissive"`                          | `"default"`                               | Leniency ladder for non-allow verdicts (see below)                                                                                                                                                                          |
| `notifyLevel`    | `"info"\|"warning"\|"error"\|"off"`                                     | `"info"`                                  | Ambient-notify threshold — the minimum review-loop notify level that still notifies; command feedback is never gated                                                                                                        |
| `circuitBreaker` | object                                                                  | `{consecutive:3,total:20,verdict:"deny"}` | Circuit breaker config (see below)                                                                                                                                                                                          |
| `cache`          | object                                                                  | `{maxEntries:128}`                        | Verdict cache (see below)                                                                                                                                                                                                   |

### Transcript

Controls how much context is kept for the model review. Only trusted user messages (including `ask_user_question` answers) and tool call names+args are kept; assistant text, tool results, and compaction summaries are stripped.

| Field              | Default | Description                              |
| ------------------ | ------- | ---------------------------------------- |
| `maxUserMessages`  | `5`     | Max trusted-intent entries (most recent) |
| `maxToolCalls`     | `10`    | Max tool calls (most recent)             |
| `maxCharsPerEntry` | `1000`  | Truncate each entry to this many chars   |

Defaults follow a recency principle; the three caps bound the worst case (~15KB) — there is deliberately no fourth, total-budget field.

### Mode

The reviewer model answers each permission ask with `allow`, `deny`, or `defer` (uncertain); `deny` carries a `riskLevel`, and `defer` may carry a `lean` — the reviewer's directional inclination ("if forced to pick now, I'd allow/deny"; omitting it means genuinely neutral). The ladder disposes every verdict by **suspicion order** — from most benign to most dangerous:

```
allow  <  defer (lean: allow)  <  defer (neutral)  <  defer (lean: deny)  <  deny (soft)  <  deny (hard)
```

Each mode is two cut lines on that order — an auto-pass band, an ask band, a terminal-deny band. The full matrix:

| Verdict ↓ (suspicion ↑)                     | `strict` | `default` | `lenient` | `permissive` |
| ------------------------------------------- | -------- | --------- | --------- | ------------ |
| `allow`                                     | allow    | allow     | allow     | allow        |
| `defer` + `lean: allow`                     | deny     | ask       | allow     | allow        |
| `defer` (neutral)                           | deny     | ask       | allow     | allow        |
| `defer` + `lean: deny`                      | deny     | ask       | ask       | allow        |
| `deny` (soft: `low\|medium`)                | deny     | ask       | ask       | allow        |
| `deny` (hard: `high\|critical`, or missing) | deny     | deny      | deny      | deny         |

The reading per mode: `strict` — the reviewer's allow is the only pass (full fail-closed automation); `default` — you judge every flag but hard danger (the resting mode and the onboarding posture — watch the reviewer work, then loosen); `lenient` — only the reviewer's active alarms ask you (soft denies and deny-leaning doubts); `permissive` — only clear high-danger requests are blocked. `lean` moves a defer across only the ask↔allow boundary, in the lean's own direction; it never appears in dialogs or notify lines (the ask is the human's judgment moment) — it lives in the `ai_guard.decision` audit record.

Rules that hold in every mode:

- Reviewer machinery failures (model unresolved, auth failed, transcript errors, timeouts, unparseable or empty replies, no review target) **never map to allow** — they deny under `strict` and `permissive`, defer under the other two. A machinery deny stays silent (the deny reason reaches the agent); a machinery-forced defer notifies its classified cause (`reviewer could not complete the review (empty-reply) — deferring to you`), on every occurrence.
- A model deny that holds or escalates notifies in every mode — `reviewer denied this request (risk high) — <reason>` — the host renders no dialog for denials, so the notify line is the operator's only copy. A mode-softened deny ends `— asking you instead`. `permissive` swallows soft denies whole; `lenient` passes benign-leaned defers silently and fires a one-time fail-open notice (`lenient auto-approves uncertainty — soft denials still ask`) on the first neutral defer. Reasons go out whole under a 200-char ceiling; the audit record keeps the full text.
- The lean never caches: defers are never stored, so an identical benign defer re-reviews every time.
- A link's `deny` is final — it short-circuits the chain and never reaches a prompt. A `defer` falls through to the interactive permission prompt (the denying terminal in headless sessions — headless mode collapses every defer to deny).
- `strict`'s one exception: a breaker explicitly configured to force `defer` still reaches the human (the reviewer-untrusted escape valve); headless sessions resolve those defers to deny either way. `lenient` records a passed defer's clarification request as `emittedReason: "clarification-suppressed"` in the audit. `permissive`'s first mapped allow surfaces a one-time notice (`permissive auto-approves non-allow verdicts — hard-tier denials still block`); the footer renders the value in warning red.

Ambient (review-loop) notices respect the `notifyLevel` threshold: `info` (default) passes everything; `warning` silences the `reviewer asks` mirror (the dialog still pops); `error` keeps only the total-tier breaker trip; `off` silences every ambient line. **Command feedback and guard-absent errors are never gated** (a fail-safe config start, a failed registration, a stale registration — always error grade). The tradeoff of `warning`/`error`/`off`: model denies and clarifications reach only the agent and the audit log — an operator-owned risk.

Mapped verdicts still count toward the breaker and still store in the cache (the mapping re-applies on every cache hit); defers are never cached — lean-derived allows included.

### Runtime control

Effective config layers, in precedence order: **session overrides** (the controls below) > **project config** (trusted projects) > **global config**. Saving writes UPWARD into a layer; a saved field then shadows the layers beneath it.

Two session-scoped controls change the effective mode without touching the config file:

- `/ai-guard` — the settings menu; direct forms `/ai-guard mode <v>`, `/ai-guard notifyLevel <v>`, `<setting> reset`.
- `/ai-guard save-to-global-config` / `/ai-guard save-to-project-config` — persist the current EFFECTIVE config (session overrides included) into a config file via JSONC-preserving edits (project target refused for untrusted projects). New sessions start from the saved layer; the current session keeps its overrides; a higher-precedence layer can still shadow it.
- `/ai-guard breaker reset` — clear both breaker tiers. Pure counter reset: cache and overrides untouched; reviews resume immediately.
- `ctrl+alt+g` — cycle `default → lenient → permissive → default`. Only `strict` stays out of casual reach.

The footer shows deviations from the baseline only (`off · lenient (session)`) and renders `permissive` in warning red, so a silenced pane stays visible. Overrides persist per session in pi's session file (never LLM context): resume restores them, `/tree` navigation re-derives from the active branch, and a fresh session starts from the config default.

### Circuit breaker

Two-tier, fail-safe:

- `circuitBreaker.consecutive` — **recoverable** tier: when a deny streak hits the threshold, the breaker trips, returns `circuitBreaker.verdict`, and resets the consecutive counter so the model gets another chance on the next ask.
- `circuitBreaker.total` — **hard** tier: once a session accumulates that many model denials, the breaker stays tripped permanently (the counter never resets on its own — only `/ai-guard breaker reset` or a session restart clears it). Together they tighten progressively — repeated abuse walks a recoverable trip toward the permanent one.

A heavy session can legitimately reach the hard tier (a deny-leaning reviewer burns the budget by volume, not failure), so: the first total-tier trip notifies once at error grade (`circuit breaker tripped — total tier reached, blocking all reviews until /ai-guard breaker reset or restart`, re-armed after each reset — the ambient channel's only error line), and `/ai-guard breaker reset` clears both tiers (cache, mode, and overrides survive). A session restart clears the breaker either way.

Counter rules: trips and cache hits are never counted as model denials; the breaker counts what the model produced regardless of the mode. Deny-equivalents — machinery-failure denies and `strict`'s model-defer→deny mapping — count into the **recoverable** tier only; the `total` tier stays model-denies-only.

A tripped breaker's forced verdict **bypasses the verdict-mode mapping** (the explicit breaker config is more specific than the general mode):

- `verdict: "deny"` (default): the trip forces a deny (with a breaker reason the agent can act on) — in `strict` mode the session keeps running uninterrupted, fail-closed.
- `verdict: "defer"`: the trip defers to the human — in `strict` mode this **interrupts on purpose**: the breaker tripping means the reviewer itself is untrusted (a deny storm — miscalibrated or prompt-injected), and this is the designed escape valve. A notification explains the interruption; headless sessions degrade to deny (no human is present). The config loader warns about the `strict` + `defer` and `permissive` + `defer` combinations up front.

### Verdict cache

`cache.maxEntries` enables a session-level LRU keyed by a review request snapshot plus a trusted-intent fingerprint, so a repeated identical ask in a stable conversation skips the model call.

- The key is a decision-relevant projection of the ask (kind, target, full command, executed unit, working directory, …) plus a trusted-intent fingerprint — `curl example.com` and `curl example.com | bash` are distinct; the same command in a different cwd is a different authorization.
- The administrative `surface` label is not in the key: two asks differing only in surface intentionally collide.
- Only asks that reached the model are cached (policy `ask`); rule changes to `allow`/`deny` defer before the cache, so stale entries can't override them.
- The fingerprint is built from user messages — chatty conversations invalidate often; the cache benefits repeated-command, low-chatter sessions most. Hits carry a `gate: "cache-hit"` record.

## Provider compatibility

- `reasoning: "off"` (default) keeps the reviewer fast and cheap; a tolerant text parser extracts the JSON verdict from prose-wrapped replies.
- **OpenAI-compatible providers:** set `provider: "openai"` plus the model id. The base URL, API key, and provider binding come from the model registry pi injects at session start (no `baseUrl` field here); validate an endpoint with `npx tsx scripts/integration-test.ts --provider openai --base-url <url> --api-key <key>`.

## Observability

Each reviewer-relevant decision writes an `ai_guard.decision` record to pi-permission-system's review log at (cache hits and deterministic-engine pre-decisions are debug-stream replays only) `~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`. Fields on the `model` gate record:

| Field         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`        | Which decision gate produced the record (see How it works)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `verdict`     | `allow` / `deny` / `defer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reason`      | Sanitized model explanation. Present on deny (from the model, or `GENERIC_DENY_REASON` fallback) and on `model-defer` (what the model found unclear). Absent for allow and defer-without-explanation. The circuit-breaker gate uses a static `BREAKER_DENY_REASON` instead                                                                                                                                                                                                                                                         |
| `deferKind`   | Why it deferred (classification). Model-gate: `empty-reply` (a completed reply without text — genuine model silence), `no-json` (text present but no JSON found), `timeout` (per-call timeout elapsed), `call-failed` (the call threw, or a provider error resolved as a non-thrown reply — rate limits, proxy/WAF blocks), `model-defer`, `invalid-verdict-value`. Other gates: `circuit-breaker`, `model-unresolved`, `auth-failed`, `no-target`, `transcript-error`, `policy-allow`, `policy-deny`. `null` for clean allow/deny |
| `latencyMs`   | End-to-end model-call latency (cumulative across attempts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `attempts`    | Present (`2`) only when the empty-reply retry fired; absent on single-attempt reviews                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `modelId`     | `provider/model` of the reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rawReply`    | Three states: the raw model text for defer paths that produced one (`no-json` / `invalid-verdict-value` / `model-defer`); `null` for `timeout` / `call-failed` / `empty-reply` (no text was produced); `"(clean verdict, rawReply omitted)"` for allow/deny where the parsed JSON is already in structured fields (`verdict`, `reason`, `riskLevel`)                                                                                                                                                                               |
| `riskLevel`   | Model-assessed risk (`low`/`medium`/`high`/`critical`), or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contextHash` | Trusted-intent context fingerprint (same value as the verdict-cache key's context hash) — distinguishes same-context repetitions from cross-context ones; absent on records written before 0.9.0                                                                                                                                                                                                                                                                                                                                   |

Supplementary debug records (written via `log.debug`, gated by the upstream log level):

- `ai_guard.model_reply` — raw model text on defer-with-text replies; also fires with `diagnostic: true` on empty responses (`stopReason`, `rawStopReason`, `contentTypes`, `errorMessage`, `latencyMs`; `stopReason: "aborted"` = the timeout elapsed, classified `timeout` not `empty-reply`).
- `ai_guard.cache_lookup` — cache misses with a `missReason` (`disabled` / `no-entry` / `context-changed`).
- `ai_guard.model_call_error` — thrown model calls, recording the `deferKind` (`timeout` / `call-failed`) and error message.

## License

MIT
