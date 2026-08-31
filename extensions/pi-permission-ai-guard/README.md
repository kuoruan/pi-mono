# pi-permission-ai-guard

A [Pi](https://github.com/earendil-works/pi) extension that reviews permission asks with a light model, using a **token-optimized stripped transcript**.

It is a consumer of [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages): it registers an `"ai-guard"` chain link that reviews `ask`-level permission requests across all configured surfaces (bash, mcp, skill).

## Why

Each model review call sends **only stripped context** (user messages + tool call names), not the full transcript. This substantially reduces token consumption by discarding assistant text and tool results — the token-heaviest parts of a transcript — with minimal impact on verdict quality.

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

Upstream failures retry once per mechanism, budgeted inside `timeoutMs` (the total-budget promise: a review never takes longer than one window). Two mechanisms, one budget: provider errors (408/409/429/5xx and connection-level failures, per pi-ai's classifier) retry inside pi-ai's provider layer (backoff and `retry-after` honored, the timeout signal spanning every attempt); an empty reply (a 200 with no usable text — e.g. an always-thinking upstream spending the whole budget on reasoning) retries at the review layer, but only when the first attempt consumed less than half the window, so the retry always has at least half a window and never runs when it would predictably time out. The retry carries no provider-layer retry of its own — three requests is the hard ceiling per review. `attempts: 2` on the decision record marks a retried review.

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

The defaults follow a recency principle: recent intent plus recent tool calls are what a verdict needs, and 1000 chars per entry balances evidence completeness against token cost. There is deliberately **no total budget field** — the worst case is bounded by the three values above (~15KB), and a fourth cap would guard a scenario the per-entry limits already contain.

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

Read down any column: the three bands are contiguous — each mode is one coherent strictness line, not a bag of special cases. The extremes are lean-inert: `strict` denies every non-`allow` (a lean is not an allow), `permissive` passes everything short of a hard deny. In the middle, `lean` moves a defer across **only** the ask↔allow boundary, in the lean's own direction — the deny band stays reachable only by decisive (hard-tier) denies. Concretely: `lenient` passes benign and neutral doubts (the reviewer already ran the full screen and found nothing dangerous, only an authorization link it cannot see — benign ones pass silently, a first neutral pass announces itself once, all audit-logged with their lean), while a `lean: deny` still asks (a deny-leaning doubt is an active alarm, and `lenient`'s contract is exactly "only active alarms ask you"). `default` asks on every unresolved doubt AND every soft deny: an unresolved verdict always keeps an ask path somewhere in the ladder, so the intent question — the one thing the reviewer structurally cannot see — can always reach the authorizer; the resting mode forwards every flag to the human. The lean is a routing signal only — it never appears in dialogs or notify lines (the ask is the human's judgment moment, and the model's own inclination must not anchor it); it lives in the `ai_guard.decision` audit record (`lean: "allow" | "deny" | null`).

The reading per mode: `strict` — the reviewer's allow is the only pass (full fail-closed automation); `default` — you judge every flag but hard danger (soft denies and every unresolved doubt ask you; the resting mode and the onboarding posture — watch the reviewer work, then loosen); `lenient` — only the reviewer's active alarms ask you (soft denies and deny-leaning doubts); `permissive` — only clear high-danger requests are blocked.

Reviewer machinery failures (model unresolved, auth failed, transcript errors, timeouts, unparseable or empty replies, no review target) **never map to allow** — a broken reviewer must not rubber-stamp: they deny under `strict` and `permissive`, and defer under the other two. Unlike a model deny (which notifies in every mode, below), a machinery deny stays silent in every mode: the deny reason reaches the agent, and a fail-closed stop needs no announcement.

(`permissive`'s machinery cell is the ladder's one non-monotone row: `lenient` defers, `permissive` denies — a defer would need a dialog the zero-interruption contract forbids, and a broken reviewer must not rubber-stamp.)

A machinery-forced defer interrupts you with no dialog context of its own, so it notifies the classified cause — `reviewer could not complete the review (empty-reply) — deferring to you` — same doctrine as the breaker trip: every unexpected interruption names itself. Repeats do not collapse: every deferral notifies, because the same failure kind can recur for different underlying reasons and each one lands on its own dialog.

A model deny that **holds or escalates** notifies in every mode — `reviewer denied this request (risk high) — <reason>` — because the host permission system renders no dialog for denials (the deny reason goes to the agent and the audit log, never a prompt — since v28 the agent-side render names this link as the refuser, so the corrective reason is read as policy rather than as the user's instruction), so the notify line is the operator's only copy. When a mode softens a deny into your decision (default/lenient soft tier) the line ends `— asking you instead`, naming the real outcome; a deny that holds needs no tail (the sentence already says it). The silent lanes are by design: `permissive` swallows soft denies whole (the reason goes to the audit log alone) — the mode's zero-interruption contract, covered by the one-time fail-open notice below — and a benign-leaned defer passes silently in `lenient` (the reviewer's own inclination confirmed needs no announcement; allows never notify) — a NEUTRAL defer's first pass fires the one-time fail-open notice (`lenient auto-approves uncertainty — soft denials still ask`), because the mode is overriding the reviewer's uncertainty rather than confirming its inclination. The reason goes out **whole** — a clarification you are asked to answer must be readable end-to-end — with a 200-char defensive ceiling (the prompt anchors reasons at ~150 characters — a concise sentence); the audit record keeps the full text either way. The reviewer prompt also binds reason to verdict: a deny reason must state what makes the request dangerous, and an assessment that concludes "safe" must be an `allow` — never a deny with a safety conclusion.

Every notify line follows one skeleton — event sentence, em-dash consequence, parenthesized qualifier (`(risk high)`, `(session override)`) — and state echoes (`mode = permissive (session override)`) are the one deliberate exception: they report a value, not an event.

Ambient (review-loop) notices respect the `notifyLevel` threshold: `info` (the default) passes everything, `warning` silences the `reviewer asks` mirror (the only ambient info line — the approval dialog still pops with the request), `error` keeps only the total-tier breaker trip (the one ambient error line — the guard's review function is down for the session and recovery needs your hand; per-request noise stays silent), and `off` silences every ambient line. **Command feedback and guard-absent errors are never gated** — the `/ai-guard` surface always answers (silence on a command you just typed reads as breakage), and the three ways the guard itself can be absent or mis-slotted notify at `error` grade through the ungated feedback channel: a fail-safe config start (no auto-review), a failed authorizer registration, and a stale registration surviving disposal. The tradeoff of `warning`/`error`/`off` is explicit: model denies and clarifications reach only the agent and the audit log, and since denials have no host dialog, the operator sees nothing — an operator-owned risk, taken knowingly.

Notes:

- A link's `deny` is final — it short-circuits the chain and never reaches a prompt. A link's `defer` falls to the next authority: the interactive permission prompt in a TUI session, the denying terminal in a headless one.
- `strict` is fully automatic and fail-closed: EVERYTHING that would otherwise fall to the human is denied. The model's own uncertainty carries the defer's clarification request as the deny's reason; machinery failures deny with the classified failure as the reason. Nothing falls to the user in strict mode, except a breaker explicitly configured to force `defer` still reaches the human (the reviewer-untrusted escape valve, with a notification explaining the interruption). Headless sessions resolve those defers to deny either way.
- `lenient` trusts the reviewer's silence: neutral and benign-leaned defers pass with their clarification request recorded as `emittedReason: "clarification-suppressed"` in the audit; its soft denies and deny-leaning doubts still ask you.
- `default` keeps the ask on every defer and every soft deny — the intent question ("is this within my authorization?") is the one the reviewer cannot see, and the resting mode forwards every flag to the only party who can answer it. It is also the onboarding posture: watch the reviewer's flags land, build trust, then loosen to `lenient` (or onward).
- `permissive` needs a verdict to pass anything: soft denies and every defer pass (deny-leaning ones included — not a new exposure: permissive passed all defers before the lean field existed, the lean only makes the audit say which way the reviewer leaned), machinery failures still deny. The first mapped allow surfaces a one-time notice (`permissive auto-approves non-allow verdicts — hard-tier denials still block`), and the footer renders the value in warning red.
- A benign-leaned defer's auto-pass is never cached (defers are never stored), so an identical ask re-reviews on every occurrence — the lean is re-derived fresh each time.
- Headless sessions collapse the modes: a `defer` always resolves to the denying terminal, so defer-based modes all deny everything the model doesn't allow — the difference lives in the audit trail and the TUI behavior.
- A tripped breaker's forced verdict bypasses the mapping by design (its forced `deny` stays terminal even under `lenient` — specific config beats the general mode).

Mapped verdicts still count toward the circuit breaker (the breaker counts what the model produced, whatever the mode) and denies are still stored in the verdict cache (the cache holds the model's deny; the mapping re-applies on every hit, so a repeated ask maps consistently without a new model call). Model defers are never cached — lean-derived allows included.

### Runtime control

Effective config layers, in precedence order: **session overrides** (the controls below) > **project config** (trusted projects) > **global config**. Saving writes UPWARD into a layer; a saved field then shadows the layers beneath it.

Two session-scoped controls change the effective mode without touching the config file:

- `/ai-guard` — opens the settings menu (each entry shows its current value and source); picking an entry opens its value picker. Direct forms: `/ai-guard mode strict|default|lenient|permissive`, `/ai-guard notifyLevel info|warning|error|off`, and `<setting> reset` (back to the config default). Argument completion is two-stage: setting names first, then the setting's values.
- `/ai-guard save-to-global-config` / `/ai-guard save-to-project-config` — persist the current EFFECTIVE config (every field, session overrides included, so future command-configured settings ride along) into the global or project config file.
- `/ai-guard breaker reset` — clear the circuit breaker's two tiers (the total tier's permanence otherwise lasts the whole session). Pure counter reset: the verdict cache and every override are untouched, and reviews resume immediately. The settings menu carries the same action as its last entry.
  - Leaves are written in place via JSONC edits: comments, formatting, and untouched keys survive; when the layer already matches, nothing is written.
  - The project target is refused for untrusted projects (that layer isn't honored there).
  - New sessions start from the saved layer; the current session keeps its overrides. A saved layer feeds new sessions but a higher-precedence layer (project > global) can still shadow it — check the layer order above when a saved value seems not to take effect. Both actions are the last picker entries.
- `ctrl+alt+g` — cycle `default → lenient → permissive → default` (one press = one notch looser; the wrap returns to the anchor). Only `strict` stays out of casual reach (full fail-closed automation deserves a deliberate choice); `permissive` rides in the cycle with its red footer emphasis as the guardrail.

The footer only shows deviations from the shipped baseline: nothing while the effective mode is `default` and `notifyLevel` is `info`; `<value>` (e.g. `lenient`) from the config; `<value> (session)` while an override is active (including after resume) — a non-default `notifyLevel` renders its fragment the same way (e.g. `off · lenient (session)`), so a silenced pane stays visible in the footer. The footer renders `permissive` in warning red (command surfaces stay plain text). The pipeline picks up the change on the next ask without re-registering the chain link, and `ai_guard.decision` records carry the effective mode at decision time.

Overrides persist **per session**: each change is appended to pi's session file as a custom entry (custom entries never enter LLM context), so resuming a session restores the last policy set on its active branch — a `reset` persists too, a fresh session always starts from the config default, and tree navigation (`/tree` rewind/branch) re-derives the override from the new active branch.

### Circuit breaker

Two-tier, fail-safe:

- `circuitBreaker.consecutive` — **recoverable** tier: when a deny streak hits the threshold, the breaker trips, returns `circuitBreaker.verdict`, and resets the consecutive counter so the model gets another chance on the next ask.
- `circuitBreaker.total` — **hard** tier: once a session accumulates that many model denials, the breaker stays tripped permanently (the counter never resets on its own — only `/ai-guard breaker reset` or a session restart clears it). Together they tighten progressively — repeated abuse walks a recoverable trip toward the permanent one.

The hard tier's permanence is deliberate (a degraded reviewer must not keep rubber-stamping), and a heavy session can legitimately reach it — a long working session with a deny-leaning reviewer burns the model-deny budget by volume, not by failure. Two escape hatches honor that: the first total-tier trip notifies the operator once at error grade (`circuit breaker tripped — total tier reached, blocking all reviews until /ai-guard breaker reset or restart`; re-armed after each reset — the notice rides the ambient channel as its only error line, so `notifyLevel` `off` silences it and consumes the once-per-epoch notice; the `error` threshold keeps it visible while silencing everything else), and `/ai-guard breaker reset` (also the settings menu's last entry) clears both tiers — a pure counter reset that touches nothing else: the verdict cache, mode, notifyLevel, and every session override survive it, and reviews resume immediately. A session restart clears the breaker either way.

What feeds the counters:

- Breaker trips and cache hits are not counted as model denials (no double-counting).
- The breaker counts what the model produced regardless of the mode — mapping never changes what the model said.
- Deny-equivalents count into the **recoverable** tier only: machinery-failure denies (`strict`/`permissive` mode's empty replies, timeouts, unparseable verdicts, unresolved models) AND `strict`'s model-defer→deny mapping (a wavering reviewer becomes a denial stream). A consistently broken or persistently uncertain reviewer trips the breaker like a miscalibrated one, so the `verdict: "defer"` escape valve also fires for those storms. The permanent `total` tier stays model-denies-only: an equivalent storm never burns the session.

A tripped breaker's forced verdict **bypasses the verdict-mode mapping** (the explicit breaker config is more specific than the general mode):

- `verdict: "deny"` (default): the trip forces a deny (with a breaker reason the agent can act on) — in `strict` mode the session keeps running uninterrupted, fail-closed.
- `verdict: "defer"`: the trip defers to the human — in `strict` mode this **interrupts on purpose**: the breaker tripping means the reviewer itself is untrusted (a deny storm — miscalibrated or prompt-injected), and this is the designed escape valve. A notification explains the interruption; headless sessions degrade to deny (no human is present). The config loader warns about the `strict` + `defer` and `permissive` + `defer` combinations up front.

### Verdict cache

`cache.maxEntries` enables a session-level LRU keyed by a review request snapshot plus a trusted-intent fingerprint, so a repeated identical ask in a stable conversation skips the model call.

- The snapshot is a decision-relevant projection of the ask — kind, review target, full command, flagged elements, command context, executed unit, canonical boundary, working directory, and the tool-input / read-path / resolved-alias slots.
- `curl example.com` and `curl example.com | bash` are distinct entries (different `executed unit`); working directory is part of the identity — the same command in a different directory is a different authorization (e.g. `rm -rf build` resolves differently per cwd).
- The gate label `surface` is **not** part of the key — it is an administrative label the model is told to ignore, so two asks sharing kind + content but differing only in surface reach the same verdict and intentionally collide.
- The cache only applies to commands that reached the model (policy `ask`); a rule change to `allow`/`deny` defers before the cache, so stale entries can't override rule changes.
- **Caveat:** the context hash is built from trusted user messages, so conversations that interject frequently invalidate entries often — the cache benefits "high-frequency repeated commands, low-chatter" sessions most.
- Cache hits carry a `gate: "cache-hit"` log entry for debugging.

## Provider compatibility

- `reasoning: "off"` (default) — thinking is disabled, keeping the reviewer fast and cheap.
- The model is prompted to respond with a JSON verdict object; a tolerant text parser extracts the verdict from the reply, so providers that wrap JSON in prose still work.
- Token optimization targets raw token minimization (stripped transcript), not prompt-cache hits — works regardless of provider caching support.
- **OpenAI-compatible providers:** set `provider: "openai"` and the model id in config. The base URL, API key, and provider binding come from the model registry that pi injects at session start, not from this extension's config — there is no `baseUrl` field. Validate an OpenAI-compatible endpoint end-to-end with `npx tsx scripts/integration-test.ts --provider openai --base-url <url> --api-key <key>`.

## Observability

Each reviewer-relevant decision writes an `ai_guard.decision` record to pi-permission-system's review log at (cache hits and deterministic-engine pre-decisions are debug-stream replays only) `~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`. Fields on the `model` gate record:

| Field       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`      | Which decision gate produced the record (see How it works)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `verdict`   | `allow` / `deny` / `defer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reason`    | Sanitized model explanation. Present on deny (from the model, or `GENERIC_DENY_REASON` fallback) and on `model-defer` (what the model found unclear). Absent for allow and defer-without-explanation. The circuit-breaker gate uses a static `BREAKER_DENY_REASON` instead                                                                                                                                                                                                                                                         |
| `deferKind` | Why it deferred (classification). Model-gate: `empty-reply` (a completed reply without text — genuine model silence), `no-json` (text present but no JSON found), `timeout` (per-call timeout elapsed), `call-failed` (the call threw, or a provider error resolved as a non-thrown reply — rate limits, proxy/WAF blocks), `model-defer`, `invalid-verdict-value`. Other gates: `circuit-breaker`, `model-unresolved`, `auth-failed`, `no-target`, `transcript-error`, `policy-allow`, `policy-deny`. `null` for clean allow/deny |
| `latencyMs` | End-to-end model-call latency (cumulative across attempts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `attempts`  | Present (`2`) only when the empty-reply retry fired; absent on single-attempt reviews                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `modelId`   | `provider/model` of the reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rawReply`  | Three states: the raw model text for defer paths that produced one (`no-json` / `invalid-verdict-value` / `model-defer`); `null` for `timeout` / `call-failed` / `empty-reply` (no text was produced); `"(clean verdict, rawReply omitted)"` for allow/deny where the parsed JSON is already in structured fields (`verdict`, `reason`, `riskLevel`)                                                                                                                                                                               |
| `riskLevel` | Model-assessed risk (`low`/`medium`/`high`/`critical`), or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Supplementary debug records (written via `log.debug`, gated by the upstream log level):

- `ai_guard.model_reply` — the raw model text on defer-with-text replies (clean verdicts omit it — the decision record's structured fields already carry the verdict, and its `rawReply` sentinel says so). Also fires with a `diagnostic: true` flag on empty model responses, capturing `stopReason`, `rawStopReason`, `contentTypes`, `errorMessage`, and `latencyMs`. A `stopReason: "aborted"` indicates the per-call timeout elapsed (the provider resolves an empty message rather than throwing) — these are classified as `deferKind: "timeout"`, not `empty-reply`.
- `ai_guard.cache_lookup` — emitted on cache misses with a `missReason` (`disabled` / `no-entry` / `context-changed`). Cache hits are covered by the `cache-hit` decision record and do not emit a duplicate debug event.
- `ai_guard.model_call_error` — emitted when a model call throws, recording the `deferKind` (`timeout` / `call-failed`) and error message.

## License

MIT
