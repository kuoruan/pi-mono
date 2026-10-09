# pi-permission-ai-guard

A [Pi](https://github.com/earendil-works/pi) extension that reviews permission asks with a light model, using a **token-optimized stripped transcript**.

It is a consumer of [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages): it registers an `"ai-guard"` link in its authorizer chain, reviewing `ask`-level permission requests on the configured surfaces (bash, mcp, skill).

## Why

Each model review call sends **only stripped context** (user messages + tool call names), not the full transcript — assistant text and tool results, the token-heaviest parts, are discarded, with minimal impact on verdict quality.

Two structural choices distinguish the reviewer from a plain classifier: the verdict **lean never feeds back** into the model's own context (each review is stateless — an agent cannot anchor the reviewer toward its own history), and both ladder extremes are **lean-inert** (`strict` denies every non-allow, `permissive` passes everything short of a hard deny or a reviewer failure — the lean only routes the middle rungs). These mitigate the classifier drift documented in Anthropic's [auto-mode writeup](https://www.anthropic.com/engineering/claude-code-auto-mode), where consent-shaped evidence in history was the top failure mode — structure instead of prompt-tuning.

## How it works

The reviewer runs a short, cheap decision on each ask and defers at the first miss:

1. Surface match: the ask's surface is in `surfaces` (otherwise defer).
2. Extract the review target (the value being authorized).
3. Policy gate: query the deterministic engine at gate parity — if the policy already says `allow` or `deny`, defer. This link only adds value when the engine is undecided (`ask`).
4. Circuit breaker: a tripped breaker short-circuits without a model call.
5. Resolve the model (fails fast on a config error).
6. Strip transcript (token-optimized, secrets redacted): feeds both the verdict cache's context fingerprint and the review prompt.
7. Verdict cache lookup: a repeated ask in a stable conversation skips the model.
8. Resolve auth — after the cache, so a cached repeat ask survives an auth flap.
9. Build prompt (the command and request fields are redacted).
10. Model review: JSON verdict.
11. Record the verdict into the breaker counters and cache.

Fail-safe by construction: a missing model, invalid config, model timeout, unparseable reply, or an unsure verdict — any unexpected error path — resolves to `defer`, and the ask falls through to the normal permission prompt.

A defer on a short approval is the same fail-safe doing its job. "Ok" or "rename it" names no action of its own: its referent is the agent's own prose, which the reviewer never sees. Both lanes judge such an anchor by the human's own words alone, and their defer reason asks the operator what the reviewer could not establish instead of only reporting the shortfall — so the operator, who did see the proposal, answers the dialog with what the reviewer could not know.

With no backups, chat reviewers retry provider failures once inside `timeoutMs`; an empty reply may also retry at the review layer. The classifier lane's direct backend uses the TypeSafe SDK's retry policy; its registry backend (`modelType: "classifier"`) uses Pi's classifier retries. With backups, provider retries are replaced by [ordered backup reviewers](#backup-chat-models) or [backup System One endpoints](#backup-system-one-endpoints), respectively.

## Transcript stripping

| Message type              | Handling                   | Why                                                                 |
| ------------------------- | -------------------------- | ------------------------------------------------------------------- |
| user message              | Keep (truncated)           | Trusted authorization signal                                        |
| compaction/branch summary | **Delete**                 | May contain model output; must never become an authorization signal |
| assistant text            | **Delete**                 | Untrusted (agent can rationalize)                                   |
| tool call                 | Keep name + truncated args | Show what agent did                                                 |
| tool result               | **Delete**                 | Untrusted (injection entry), token-heaviest                         |
| question tool result      | Keep (trusted intent)      | The human's own answers, as the tool returned them                  |

## Setup

Two extensions, two config files: **pi-permission-system** owns the policy and the chain (its config names the link); **this extension** declares the reviewer model and behavior.

1. Install [pi-permission-system](https://github.com/gotgenes/pi-packages) (>= 27.1.1) and configure its permission policy — see its [Quick Start](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/README.md#quick-start).

   ```bash
   pi install npm:@gotgenes/pi-permission-system
   ```

2. Install this extension:

   ```bash
   pi install npm:pi-permission-ai-guard
   ```

   Or add to `settings.json`: `{ "packages": ["npm:pi-permission-ai-guard"] }`.

3. **Name the link** in pi-permission-system's config — installing the extension registers the link, but a link decides nothing until you name it (the chain is opt-in):

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-system/config.json
   { "authorizerChain": ["ai-guard"] }
   ```

4. Declare the reviewer in this extension's config (`config.jsonc` or `config.json`, JSONC — comments and trailing commas are fine; when both exist, `config.jsonc` wins):

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-ai-guard/config.jsonc
   {
     "provider": "anthropic",
     "model": "claude-haiku-4-5",
     "reasoning": "off",
     "timeoutMs": 15000,
     "surfaces": ["bash", "mcp", "skill"],
   }
   ```

See [`config/config.example.json`](config/config.example.json) for a complete example.

Chain facts that shape how this link behaves:

- **Only `ask` reaches the chain** — a request the deterministic policy already decided (`allow`/`deny`) never consults the link.
- **Config order fixes chain order**, never registration order; a missing link is skipped fail-safe — absence means more prompting, never less.
- **The chain owner caps a link's `allow` on the `external_directory`/`path` surface families to `defer`** — reviewing those surfaces can deny or defer, never allow. The default `surfaces` list stays clear of them.
- **A subagent's ask is reviewed one hop up** — by the chain of the session serving it, so your links review subagent asks in the session you are watching.
- The chain ends at the default terminal: the interactive prompt (or a headless deny).

> **Where to put hard-deny rules:** secrets, dangerous commands, and safe auto-allow patterns belong in **pi-permission-system's** rule config, not here. The link queries the engine at gate parity and defers whenever the engine already decided — a deterministic block costs no model call and holds in every mode.

## Configuration

| Field             | Type                                                                    | Default                                   | Description                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | string\|object                                                          | required                                  | Model provider id (e.g. `anthropic`), or `{type:"typesafe", baseUrl?, apiKey?}` for the classifier reviewer (unset fields fall back to `TYPESAFE_BASE_URL` / `TYPESAFE_API_KEY`)                                                                                                                                                         |
| `model`           | string                                                                  | required                                  | Model id (e.g. `claude-haiku-4-5`; classifier: `jev-1.13`)                                                                                                                                                                                                                                                                               |
| `modelType`       | `"chat"\|"classifier"`                                                  | `"chat"`                                  | Registry model type (string providers only): `classifier` runs Pi's built-in classifier via `modelRegistry.classify` (pi 0.99+); rejected on direct System One connections                                                                                                                                                               |
| `reasoning`       | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"off"`                                   | Thinking level (pi-ai `ModelThinkingLevel`); `off` = disabled. Ignored in classifier mode                                                                                                                                                                                                                                                |
| `timeoutMs`       | integer                                                                 | `15000`                                   | Per-reviewer timeout (ms). The primary uses it verbatim, and it is also the classifier primary's knob — there is no separate one; a backup entry defaults to `min(this, 10s)` and may override with its own `timeoutMs`                                                                                                                  |
| `maxTokens`       | integer                                                                 | `4096`                                    | Reviewer answer budget. On budget-based reasoning providers (Anthropic, Bedrock) pi-ai adds the thinking budget on top, so the outbound cap can exceed this value (bounded by the model's own `maxTokens`); effort-based providers use it as the cap. Unused when `reasoning` is `off`. Ignored in classifier mode                       |
| `transcript`      | object                                                                  | see below                                 | Transcript stripping config (see below)                                                                                                                                                                                                                                                                                                  |
| `surfaces`        | string[]                                                                | `["bash","mcp","skill"]`                  | Surfaces to review; glob patterns (`*`, `ns:*`, `*:bar`); `!` excludes. Path-family granularity: `path` = whole family, `path_*` = proven-direction access only, `path_read` = one direction, `!path` = family-wide exclude                                                                                                              |
| `instructions`    | string\|object\|null                                                    | `null`                                    | Custom safety rules. String = broadcast append to both lanes. Object = per-lane slots (`chat.rules`, `classifier.background` + `classifier.questions`, ids: `danger_category`, `intent_match`, `risk`); `chat.replace: true` swaps the chat built-in rules instead of appending (the classifier lane is append-only). `null` = built-ins |
| `classifier`      | object                                                                  | see below                                 | Classifier verdict thresholds — pure policy, no transport knobs (read on both classifier backends)                                                                                                                                                                                                                                       |
| `fallbacks`       | array                                                                   | `[]`                                      | Ordered backup reviewers in any lane (registry model or System One endpoint), each with `provider`, `model`, and optional `timeoutMs`                                                                                                                                                                                                    |
| `mode`            | `"strict"\|"default"\|"lenient"\|"permissive"`                          | `"default"`                               | Leniency ladder for non-allow verdicts (see below)                                                                                                                                                                                                                                                                                       |
| `notifyLevel`     | `"info"\|"warning"\|"error"\|"off"`                                     | `"info"`                                  | Ambient-notify threshold — the minimum review-loop notify level that still notifies; command feedback is never gated                                                                                                                                                                                                                     |
| `notifyApprovals` | boolean                                                                 | `false`                                   | Show a notice when AI Guard approves a request; requires `notifyLevel: "info"`                                                                                                                                                                                                                                                           |
| `circuitBreaker`  | object                                                                  | `{consecutive:3,total:20,verdict:"deny"}` | Circuit breaker config (see below)                                                                                                                                                                                                                                                                                                       |
| `cache`           | object                                                                  | `{maxEntries:128}`                        | Verdict cache (see below)                                                                                                                                                                                                                                                                                                                |

### Environment variables in config

Any string value may reference environment variables:

- `${NAME}` expands to the variable's value, and `${NAME:-fallback}` uses the fallback when the variable is unset or empty. `$$` writes a literal `$`.
- `$NAME` without braces, `${NAME:?…}`, and command substitution stay literal text — nothing here runs a shell.
- Expansion happens per layer as it loads, and the result is type-checked like any other value: a number field holding `"${PORT}"` is still a string and fails the load.

```json
{
  "provider": { "type": "typesafe", "baseUrl": "${MY_GATEWAY_URL}" },
  "model": "${AI_GUARD_MODEL:-jev-1.13}"
}
```

A ref with no value and no fallback skips that layer (the layer beneath it still applies) and the loader reports it by variable name, never by the value it sat in. **Saving** a config keeps the placeholder: a leaf read as `"${MY_GATEWAY_URL}"` is written back as that ref rather than as its expanded value, so `/ai-guard save-config` never persists a secret that only lived in the environment. A ref that no longer resolves — or that now resolves to a value other than the one being saved — refuses the write and names the ref.

### Transcript

Caps for the stripped transcript (see the stripping table above). Defaults follow a recency principle; the three caps bound the worst case (~15KB) — there is deliberately no fourth, total-budget field.

| Field              | Default | Description                              |
| ------------------ | ------- | ---------------------------------------- |
| `maxUserMessages`  | `5`     | Max trusted-intent entries (most recent) |
| `maxToolCalls`     | `10`    | Max tool calls (most recent)             |
| `maxCharsPerEntry` | `1000`  | Truncate each entry to this many chars   |

### Backup chat models

Free models may hit usage limits or disappear without notice. In chat-model mode, `fallbacks` names other models already available in Pi's model registry:

```json
{
  "provider": "opencode-free",
  "model": "<free-model-id>",
  "fallbacks": [{ "provider": "anthropic", "model": "claude-haiku-4-5", "timeoutMs": 5000 }]
}
```

Each backup uses its own registered provider credentials; this config does not accept API keys or base URLs for chat-model entries. AI Guard tries backups in order, and only on availability failures:

- switch: the model disappears from the registry, or its provider clearly reports quota/payment limits, an unavailable model (HTTP 404/410), a timeout, network failure, or server error;
- stop and ask you instead: ambiguous errors, a real allow, deny, or uncertain verdict, a malformed reply, an authentication failure, or an access refusal — backups never get a second vote on a decision.

Auth failure on any backup stops the chain rather than bypassing that provider. When all models fail, the existing mode rules apply; nothing gets automatically approved by an outage. An explicitly configured backup's allow is trusted even in `strict` mode.

With backups, each model gets one provider attempt rather than the normal provider retry; an empty successful reply may still retry within that model's timeout. `timeoutMs` applies to each model unless its entry overrides it. The whole walk also has a budget ceiling (`max(2 × primary timeout, 30s)`, mirroring LiteLLM's 30s router timeout): each endpoint gets `min(its own timeout, remaining budget)`, and the walk stops once under 2s remain. Fallback entries default to `min(top-level timeoutMs, 10s)` (LiteLLM `request_timeout` convention — backups are usually cheap fast models); an explicit per-entry `timeoutMs` always wins. Without backups, a single endpoint keeps the SDK's normal retry behavior, where `timeoutMs` bounds each attempt rather than the total. Backup verdicts are not cached, so the primary is retried on the next ask. Failover transitions appear as `ai_guard.fallback` review records without URLs, credentials, or provider error text. Every contacted model receives the permission request (including command text and target paths) plus stripped conversation context: choose providers you trust with that data and account for their costs.

`fallbacks` accepts either lane in any order: a chat-model entry names a registry model (`{ "provider": "anthropic", "model": "..." }`), a System One entry carries its own URL, key and model. A registry classifier fallback adds `"modelType": "classifier"`; a fallback whose model is missing from Pi's catalog is skipped with a warning, while an unresolvable primary fails the session (config not applied). A string `instructions` broadcasts the same appended content to both lanes; an object carries per-lane slots (`chat` / `classifier`) — see [Custom rules](#custom-rules). Configure a classifier primary with the object-form provider below.

### Custom rules

`instructions` is one top-level field for both lanes; its default `null` runs the built-ins. A **string** broadcasts: the same text is appended to every lane's built-in instructions (a chat model's safety rules; the classifier's shared reviewer background).

```json
{
  "instructions": "This project never touches /etc or ~/.ssh; any action there is unauthorized."
}
```

An **object** carries per-lane slots. `chat.rules` holds the chat lane's text; `classifier.background` holds the classifier's shared background; `classifier.questions` adds per-question notes keyed by the stable question id (`danger_category`, `intent_match`, `risk` — an unknown id is rejected, not ignored). A lane with no slot runs its built-ins.

```json
{
  "instructions": {
    "chat": { "rules": "Deploys go through railway up." },
    "classifier": {
      "background": "Monorepo: each package owns its directory.",
      "questions": {
        "danger_category": "Deleting migration files counts as irreversible destruction.",
        "risk": "Touching /migrations is at least medium risk."
      }
    }
  }
}
```

Only the `chat` slot takes `replace: true`, which swaps the built-in safety-rules block for the slot's content instead of appending to it. The classifier lane is append-only: its built-in reviewer background, questions, and criteria are the answer contract the verdict thresholds are calibrated against — the background sentence defines the "authorization anchor" the `intent_match` criteria read against — so nothing there is replaceable. The verdict output format is likewise never replaceable, so a replacement can never change what the parser expects.

The example above assumes the pool has both a chat and a classifier reviewer: a slot for a lane the configured pool never runs is rejected (it would silently do nothing), so a chat-only pool writes just `chat`.

A slot whose lane no configured reviewer declares is rejected (it would silently do nothing); a lane declared only by a fallback can still go unused if that fallback is later skipped, which the loader reports. A lane the object leaves out keeps its full built-ins — also reported as a notice, so a half-covered pool is never silent.

### Classifier reviewer (`typesafe`)

Set `provider` to `{ "type": "typesafe" }` to review through TypeSafe's System One classifier instead of a chat model. `type` is spelled `"typesafe"` because it names the SDK protocol the client speaks; the verdict thresholds live in the separate `classifier` block. `model` carries the classifier id (`jev-1.13`, `jev-latest`). Connection fields are optional: unset `baseUrl`/`apiKey` fall back to `TYPESAFE_BASE_URL` / `TYPESAFE_API_KEY`, then the SDK built-in default URL. Pointing `baseUrl` at `https://openrouter.ai/api` with an OpenRouter key routes through OpenRouter (model ids pass through bare; responses carry extra `id`/`provider`/`usage.cost`, passed through).

Set `"modelType": "classifier"` on a string provider instead to run the same reviewer through Pi's built-in classifier (`{ "provider": "typesafe", "model": "jev-latest", "modelType": "classifier" }` — no API key in config, auth lives in Pi; needs pi 0.99+). The overlay format is identical; a registry primary missing from Pi's catalog fails the session, a missing registry fallback is skipped.

| Field                 | Default | Description                                                                      |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `intentThreshold`     | `0.5`   | Intent probability at or above which the anchor counts as authorizing the action |
| `riskThreshold`       | `0.5`   | Risk score at or above which the action denies; the tier follows the score       |
| `confidenceThreshold` | `0.5`   | Minimum answer confidence; below it the verdict defers                           |

The primary reviewer's timeout is the top-level `timeoutMs`, for the classifier lane exactly as for chat; a backup overrides it with its own entry-level `timeoutMs`.

`riskLevel` reads the fixed quartile bands of the 0–4 rubric (low below 0.25, medium below 0.5, high below 0.75, critical at or above) and does not move with `riskThreshold`; `riskThreshold` alone decides the deny. `lean` is the danger direction, derived not declared: a risk score at or above the line leans deny, a pure intent gap with trusted readings leans allow, anything else is neutral. A response missing a reading is malformed and routes to a machinery defer (never allow); missing confidence just reads as uncertain. How the three answers reach each verdict row is mapped out in [Mode](#mode).

`instructions` appends in this lane — see [Custom rules](#custom-rules).

#### Backup System One endpoints

If your primary classifier service runs out of quota, removes a free model, or becomes unavailable, set `fallbacks` to an ordered list of other [System One-compatible](https://docs.typesafe.ai/concepts/system-one) endpoints. This works with OpenRouter, Command Code's Provider API, and compatible local servers; it is not tied to a particular vendor. Each backup needs its own URL, API key, and model ID:

```json
{
  "provider": {
    "type": "typesafe",
    "baseUrl": "https://primary.example/api",
    "apiKey": "<PRIMARY_KEY>"
  },
  "model": "jev-1.13",
  "fallbacks": [
    {
      "provider": {
        "type": "typesafe",
        "baseUrl": "https://openrouter.ai/api",
        "apiKey": "<BACKUP_KEY>"
      },
      "model": "jev-1.13",
      "timeoutMs": 3000
    }
  ]
}
```

The SDK appends `/v1/systemone` to each base URL. For Command Code use `https://api.commandcode.ai/provider` and `typesafe/jev` (Provider API access requires an eligible plan); for a local compatible server use its base URL and model ID. The local server must expose the System One API, not just a chat endpoint. The SDK requires a key string even if your local server does not check it.

AI Guard tries a backup only after an availability failure (quota or payment limit, missing model/endpoint, HTTP 409/425 conflict, connection, timeout, or server error — one table shared with the chat-model lane). The no-second-vote rule, the stop-and-ask cases, and the all-failed behavior are the same as the chat-model lane above: a real allow, deny, or uncertain decision is final, and nothing gets automatically approved by an outage. A backup's valid allow is treated as a reviewer allow **even in `strict` mode**: configuring a backup explicitly trusts it to decide when the primary cannot answer. Fallback attempts appear in the permission review log without URLs or keys. Backup decisions are not cached, so the primary gets another chance next time. Backups receive the same permission request (including command text and target paths) and stripped conversation context; use only providers you trust with that data. If a local model produces different probability scales, test its approval thresholds before trusting it with permissions.

With backups configured, each endpoint gets one SDK request rather than the SDK's normal retries. Timeouts apply **per endpoint**, so set the top-level `timeoutMs` (the primary) and each backup's optional `timeoutMs` low enough for an acceptable worst-case wait. Without backups, the SDK's normal retry behavior is unchanged.

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

The classifier lane reaches the same vocabulary through its three answers (`riskThreshold` defaults to 0.5):

| Classifier answers ↓                                         | Verdict                                     | strict | default | lenient | permissive |
| ------------------------------------------------------------ | ------------------------------------------- | ------ | ------- | ------- | ---------- |
| authorized, low risk, confident                              | allow                                       | allow  | allow   | allow   | allow      |
| unauthorized, low risk, confident                            | defer + `lean: allow`                       | deny   | ask     | allow   | allow      |
| low risk, unsure                                             | defer (neutral)                             | deny   | ask     | allow   | allow      |
| high risk, unsure                                            | defer + `lean: deny`                        | deny   | ask     | ask     | allow      |
| medium risk, confident (only when the line is set below 0.5) | deny soft                                   | deny   | ask     | ask     | allow      |
| danger hit (any confidence)                                  | deny hard                                   | deny   | deny    | deny    | deny       |
| high risk, confident                                         | deny (high or critical at the default line) | deny   | deny    | deny    | deny       |

With the default line at 0.5, every decisive risk deny reads high or critical and blocks in every mode; lower the line below 0.5 to reopen a soften-able band.

Rules that hold in every mode:

- Reviewer machinery failures (model unresolved, auth failed, transcript errors, timeouts, unparseable or empty replies, no review target) **never map to allow** — they deny under `strict` and `permissive`, defer under the other two. A machinery deny stays silent (the deny reason reaches the agent); a machinery-forced defer notifies its classified cause (`reviewer could not complete the review (empty-reply) — deferring to you`), on every occurrence.
- A model deny that holds or escalates notifies in every mode — `reviewer denied this request (risk high) — <reason>` — the host renders no dialog for denials, so the notify line is the operator's only copy. A mode-softened deny ends `— asking you instead`. `permissive` swallows soft denies whole; `lenient` passes benign-leaned defers silently and fires a one-time fail-open notice (`lenient auto-approves uncertainty — soft denials still ask`) on the first neutral defer. Reasons go out whole; the audit record keeps the full text.
- The lean never caches: defers are never stored, so an identical benign defer re-reviews every time.
- A link's `deny` is final — it short-circuits the chain and never reaches a prompt. A `defer` falls through to the interactive permission prompt (the denying terminal in headless sessions — headless mode collapses every defer to deny).
- `strict`'s one exception: a breaker explicitly configured to force `defer` still reaches the human (the reviewer-untrusted escape valve); headless sessions resolve those defers to deny either way. `lenient` records a passed defer's clarification request as `emittedReason: "clarification-suppressed"` in the audit. `permissive`'s first mapped allow surfaces a one-time notice (`permissive auto-approves non-allow verdicts — hard-tier denials still block`); the footer renders the value in warning red.

Set `"notifyApprovals": true` to see when AI Guard approves a request. Fresh reviews show their total cost (`reviewer approved this request (1.2s)`; mode-mapped allows name the mode), cache replays say `(cached)`. Notices never include the command or target. Off by default.

Ambient (review-loop) notices respect the `notifyLevel` threshold: `info` (default) passes everything, including opted-in approval notices; `warning` silences approval notices and the `reviewer asks` mirror (the dialog still pops); `error` keeps only the total-tier breaker trip; `off` silences every ambient line. **Command feedback and guard-absent errors are never gated** (a fail-safe config start, a failed registration, a stale registration — always error grade). The tradeoff of `warning`/`error`/`off`: model denies and clarifications reach only the agent and the audit log — an operator-owned risk.

Mapped verdicts still count toward the breaker and still store in the cache (the mapping re-applies on every cache hit); defers are never cached — lean-derived allows included.

### Runtime control

Effective config layers, in precedence order: **session overrides** (the controls below) > **project config** (trusted projects) > **global config**. Saving writes UPWARD into a layer; a saved field then shadows the layers beneath it.

- `/ai-guard` — the settings menu (settings, save, breaker, and the report/denied panels are all menu rows); direct forms `/ai-guard mode <v>`, `/ai-guard notify-level <v>`, `<setting> reset` (a setting's verb is its config field's kebab form — the command shape used across pi's built-ins; menus show the phrase form, `notify level`).
- `/ai-guard save-config <global|project>` (a bare `save-config` opens a target picker) — persist the current EFFECTIVE config (session overrides included) into a config layer via JSONC-preserving edits (project target refused for untrusted projects). New sessions start from the saved layer; the current session keeps its overrides; a higher-precedence layer can still shadow it.
- `/ai-guard breaker reset` — clear both trip tiers. Pure counter reset: cache and overrides untouched; reviews resume immediately.
- `/ai-guard report` — suggest permission-rule fragments for repeatedly-reviewed asks (same ask 3+ times, one context, no denies) — copy-paste evidence, never an applied rule.
- `/ai-guard denied` — browse this session's model denies; pick one to see its full reason.
- `ctrl+alt+g` — cycle `default → lenient → permissive → default`. Only `strict` stays out of casual reach.

The footer shows deviations from the baseline only (`off · lenient (session)`) and renders `permissive` in warning red, so a silenced pane stays visible. Overrides persist per session in pi's session file (never model context): resume restores them, `/tree` navigation re-derives from the active branch, and a fresh session starts from the config default.

### Circuit breaker

Two-tier, fail-safe:

- `circuitBreaker.consecutive` — **recoverable** tier: when a deny streak hits the threshold, the breaker trips, returns `circuitBreaker.verdict`, and resets the consecutive counter so the model gets another chance on the next ask.
- `circuitBreaker.total` — **hard** tier: once a session accumulates that many model denials, the breaker stays tripped permanently (the counter never resets on its own — only `/ai-guard breaker reset` or a session restart clears it). Together they tighten progressively — repeated abuse walks a recoverable trip toward the permanent one.

A heavy session can legitimately reach the hard tier (a deny-leaning reviewer burns the budget by volume, not failure), so: the first total-tier trip notifies once at error grade (`circuit breaker tripped — total tier reached, blocking all reviews until /ai-guard breaker reset or restart`, re-armed after each reset — the ambient channel's only error line), and `/ai-guard breaker reset` clears both tiers (cache, mode, and overrides survive). A session restart clears the breaker either way.

Counter rules: trips and cache hits are never counted as model denials; the breaker counts what the model produced regardless of the mode. Deny-equivalents — machinery-failure denies and `strict`'s model-defer→deny mapping — count into the **recoverable** tier only; the `total` tier stays model-denies-only.

A tripped breaker's forced verdict **bypasses the verdict-rule mapping** (the explicit breaker config is more specific than the general mode):

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

| Field         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gate`        | Which decision gate produced the record (see How it works)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `verdict`     | `allow` / `deny` / `defer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reason`      | Sanitized model explanation. Present on deny (from the model, or `GENERIC_DENY_REASON` fallback) and on `model-defer` (what the model found unclear). Absent for allow and defer-without-explanation. The circuit-breaker gate uses a static `BREAKER_DENY_REASON` instead                                                                                                                                                                                                                                                                                                                                   |
| `deferKind`   | Why it deferred (classification). Model-gate: `empty-reply` (a completed reply without text — genuine model silence), `no-json` (text present but no JSON found), `timeout` (per-call timeout elapsed), `call-failed` (the call threw, or a provider error resolved as a non-thrown reply — rate limits, proxy/WAF blocks; classifier 429s retry inside the SDK only when no backups are configured), `model-defer`, `invalid-verdict-value`. Other gates: `circuit-breaker`, `model-unresolved`, `auth-failed`, `no-target`, `transcript-error`, `policy-allow`, `policy-deny`. `null` for clean allow/deny |
| `latencyMs`   | End-to-end model-call latency (cumulative across attempts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `attempts`    | Present (`2`) only when the empty-reply retry fired; absent on single-attempt reviews                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `modelId`     | `provider/model` of the reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `rawReply`    | Three states: the raw model text for defer paths that produced one (`no-json` / `invalid-verdict-value` / `model-defer`), elided in the middle past 2000 characters before storage; `null` for `timeout` / `call-failed` / `empty-reply` (no text was produced); `"(clean verdict, rawReply omitted)"` for allow/deny where the parsed JSON is already in structured fields (`verdict`, `reason`, `riskLevel`)                                                                                                                                                                                               |
| `riskLevel`   | Model-assessed risk (`low`/`medium`/`high`/`critical`), or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `contextHash` | Trusted-intent context fingerprint (same value as the verdict-cache key's context hash) — distinguishes same-context repetitions from cross-context ones                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

When a classifier endpoint or chat-model provider fails and another endpoint is available, `ai_guard.fallback` writes a separate review-stream record for the transition (`failedEndpoint`, `nextEndpoint`, `modelId`, `reason`). Endpoint positions are zero-based (primary = 0); the record omits URLs, API keys, and provider error bodies. Each transition is logged alongside the final `ai_guard.decision` record.

Supplementary debug records (written via `log.debug`, gated by the upstream log level):

- `ai_guard.model_reply` — raw model text on defer-with-text replies; also fires with `diagnostic: true` on empty responses (`stopReason`, `rawStopReason`, `contentTypes`, `errorMessage`, `latencyMs`; `stopReason: "aborted"` = the timeout elapsed, classified `timeout` not `empty-reply`).
- `ai_guard.cache_lookup` — cache misses with a `missReason` (`disabled` / `no-entry` / `context-changed`).
- `ai_guard.model_call_error` — thrown model calls, recording the `deferKind` (`timeout` / `call-failed`) and error message.

## License

MIT
