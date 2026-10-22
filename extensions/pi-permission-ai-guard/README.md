# pi-permission-ai-guard

A [Pi](https://github.com/earendil-works/pi) extension that reviews permission asks with a light model, using a **token-optimized stripped transcript**.

It is a consumer of [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages): it registers an `"ai-guard"` link in its authorizer chain, reviewing `ask`-level permission requests on the configured surfaces (bash, mcp, skill).

## Why

Each model review call sends **only stripped context** (user messages + tool call names), not the full transcript. Assistant text and tool results, the token-heaviest parts, are discarded, with minimal impact on verdict quality.

Two structural choices distinguish the reviewer from a plain classifier. The verdict **lean never feeds back** into the model's own context (each review is stateless, so an agent cannot anchor the reviewer toward its own history), and `strict` is **lean-inert** (it denies every non-allow). `auto` is ask-free instead: the lean decides between allow and deny there, so a danger-leaned doubt blocks rather than auto-flowing into an allow. This answers the classifier drift in Anthropic's [auto-mode writeup](https://www.anthropic.com/engineering/claude-code-auto-mode), where consent-shaped evidence in history was the top failure mode: structure instead of prompt-tuning.

## How it works

The reviewer runs a short, cheap decision on each ask and defers at the first miss:

1. Surface match: the ask's surface is in `surfaces` (otherwise defer).
2. Extract the review target (the value being authorized).
3. Policy gate: query the deterministic engine at gate parity. If the policy already says `allow` or `deny`, defer: this link only adds value when the engine is undecided (`ask`).
4. Circuit breaker: a tripped breaker short-circuits without a model call.
5. Resolve the model (fails fast on a config error).
6. Strip transcript (token-optimized, secrets redacted): feeds both the verdict cache's context fingerprint and the review prompt.
7. Verdict cache lookup: a repeated ask in a stable conversation skips the model.
8. Resolve auth after the cache, so a cached repeat ask survives an auth flap.
9. Build prompt (the command and request fields are redacted).
10. Model review: JSON verdict.
11. Record the verdict into the breaker counters and cache. Any miss along the way resolves to `defer`: missing model, invalid config, timeout, unparseable reply, unsure verdict. The ask falls through to the normal permission prompt.

A defer on a short approval ("Ok", "rename it") is the same fail-safe: the anchor's referent is the agent's prose, which the reviewer never sees. The defer reason names what could not be established and asks the one thing that would settle it. The operator saw the proposal; the reviewer did not.

With no backups, chat reviewers retry provider failures once inside `timeoutMs`; an empty reply may also retry at the review layer. The classifier lane (`modelType: "classifier"`) uses Pi's classifier retries. With backups, provider retries are replaced by [ordered backup reviewers](#backup-chat-models).

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

1. Install [pi-permission-system](https://github.com/gotgenes/pi-packages) (>= 40.0.0, which itself requires pi >= 1.0.0) and configure its permission policy; see its [Quick Start](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/README.md#quick-start).

   ```bash
   pi install npm:@gotgenes/pi-permission-system
   ```

2. Install this extension:

   ```bash
   pi install npm:pi-permission-ai-guard
   ```

   Or add to `settings.json`: `{ "packages": ["npm:pi-permission-ai-guard"] }`.

3. **Name the link** in pi-permission-system's config. Installing the extension registers the link, but a link decides nothing until you name it (the chain is opt-in):

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-system/config.json
   { "authorizerChain": ["ai-guard"] }
   ```

4. Declare the reviewer in this extension's config (`config.jsonc` or `config.json`; JSONC, so comments and trailing commas are fine; when both exist, `config.jsonc` wins):

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

- **Only `ask` reaches the chain**: a request the deterministic policy already decided (`allow`/`deny`) never consults the link.
- **Config order fixes chain order**, never registration order. A missing link is skipped fail-safe: absence means more prompting, never less.
- **The chain owner caps a link's `allow` on the `external_directory`/`path` surface families to `defer`**: reviewing those surfaces can deny or defer, never allow. The default `surfaces` list stays clear of them.
- **A subagent's ask is reviewed one hop up**, by the chain of the session serving it, so your links review subagent asks in the session you are watching.
- The chain ends at the default terminal: the interactive prompt (or a headless deny).

> **Where to put hard-deny rules:** secrets, dangerous commands, and safe auto-allow patterns belong in **pi-permission-system's** rule config, not here. The link queries the engine at gate parity and defers whenever the engine already decided. A deterministic block costs no model call and holds in every mode.

## Configuration

| Field             | Type                                                                    | Default                                   | Description                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | string                                                                  | required                                  | Model provider id registered in Pi (e.g. `anthropic`, or `typesafe` for the classifier reviewer)                                                                                                                                                                                                                                   |
| `model`           | string                                                                  | required                                  | Model id (e.g. `claude-haiku-4-5`; classifier: `jev-1.13`)                                                                                                                                                                                                                                                                         |
| `modelType`       | `"chat"\|"classifier"`                                                  | `"chat"`                                  | Registry model type: `classifier` runs Pi's built-in classifier via `modelRegistry.classify` (pi 1.0+)                                                                                                                                                                                                                             |
| `reasoning`       | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"off"`                                   | Thinking level (pi-ai `ModelThinkingLevel`); `off` = disabled. Ignored in classifier mode                                                                                                                                                                                                                                          |
| `timeoutMs`       | integer                                                                 | `15000`                                   | Per-reviewer timeout (ms). The primary uses it verbatim, and it is also the classifier primary's knob — there is no separate one; a backup entry defaults to `min(this, 10s)` and may override with its own `timeoutMs`                                                                                                            |
| `maxTokens`       | integer                                                                 | `4096`                                    | Reviewer answer budget. On budget-based reasoning providers (Anthropic, Bedrock) pi-ai adds the thinking budget on top, so the outbound cap can exceed this value (bounded by the model's own `maxTokens`); effort-based providers use it as the cap. Unused when `reasoning` is `off`. Ignored in classifier mode                 |
| `temperature`     | number (0–2)                                                            | unset                                     | Chat-lane sampling temperature; `0` for a reviewer that reads the same request the same way (see Provider compatibility). A `fallbacks` entry may override it. Ignored in classifier mode                                                                                                                                          |
| `transcript`      | object                                                                  | see below                                 | Transcript stripping config (see below)                                                                                                                                                                                                                                                                                            |
| `surfaces`        | string[]                                                                | `["bash","mcp","skill"]`                  | Surfaces to review; glob patterns (`*`, `ns:*`, `*:bar`); `!` excludes. Path-family granularity: `path` = whole family, `path_*` = proven-direction access only, `path_read` = one direction, `!path` = family-wide exclude                                                                                                        |
| `instructions`    | string\|object\|null                                                    | `null`                                    | Custom safety rules. String = broadcast append to both lanes. Object = per-lane slots (`chat.rules`, `classifier.background` + `classifier.questions`, ids: `ban`, `effect`, `target`, `intent`); `chat.replace: true` swaps the chat built-in rules instead of appending (the classifier lane is append-only). `null` = built-ins |
| `classifier`      | object                                                                  | see below                                 | Classifier verdict thresholds — pure policy, no transport knobs                                                                                                                                                                                                                                                                    |
| `fallbacks`       | array                                                                   | `[]`                                      | Ordered backup reviewers in either lane, each with `provider`, `model`, and optional `timeoutMs` and `temperature`                                                                                                                                                                                                                 |
| `mode`            | `"strict"\|"default"\|"auto"\|"custom"`                                 | `"default"`                               | Leniency ladder for non-allow verdicts (see below)                                                                                                                                                                                                                                                                                 |
| `customMode`      | object\|null                                                            | `null`                                    | Your own ladder row, read only when `mode` is `"custom"` (see below)                                                                                                                                                                                                                                                               |
| `notifyLevel`     | `"info"\|"warning"\|"error"\|"off"`                                     | `"info"`                                  | Ambient-notify threshold — the minimum review-loop notify level that still notifies; command feedback is never gated                                                                                                                                                                                                               |
| `notifyApprovals` | boolean                                                                 | `false`                                   | Show a notice when AI Guard approves a request; requires `notifyLevel: "info"`                                                                                                                                                                                                                                                     |
| `circuitBreaker`  | object                                                                  | `{consecutive:3,total:20,verdict:"deny"}` | Circuit breaker config (see below)                                                                                                                                                                                                                                                                                                 |
| `cache`           | object                                                                  | `{maxEntries:128}`                        | Verdict cache (see below)                                                                                                                                                                                                                                                                                                          |

### Environment variables in config

Any string value may reference environment variables:

- `${NAME}` expands to the variable's value, and `${NAME:-fallback}` uses the fallback when the variable is unset or empty. `$$` writes a literal `$`.
- `$NAME` without braces, `${NAME:?…}`, and command substitution stay literal text — nothing here runs a shell.
- Expansion happens per layer as it loads, and the result is type-checked like any other value: a number field holding `"${PORT}"` is still a string and fails the load.

```json
{
  "provider": "${MY_PROVIDER:-anthropic}",
  "model": "${AI_GUARD_MODEL:-jev-1.13}"
}
```

A ref with no value and no fallback skips that layer (the layer beneath it still applies) and the loader reports it by variable name, never by the value it sat in. **Saving** a config keeps the placeholder: a leaf read as `"${MY_GATEWAY_URL}"` is written back as that ref rather than as its expanded value, so `/ai-guard save-config` never persists a secret that only lived in the environment. A ref that no longer resolves, or that now resolves to a value other than the one being saved, refuses the write and names the ref.

### Transcript

Caps for the stripped transcript (see the stripping table above). Defaults follow a recency principle; the three caps bound the worst case (~15KB). There is deliberately no fourth, total-budget field.

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

Each backup uses its own registered provider credentials; this config does not accept API keys or base URLs for chat-model entries. AI Guard tries backups in order, and only on availability failures (quota, missing model, timeout, connection, server error — the same table as the classifier lane). Anything decided — a real allow, deny, or uncertain verdict, a malformed reply, an auth failure, a refusal — stops and asks you instead: backups never get a second vote.

Auth failure on any backup stops the chain rather than bypassing that provider. When all models fail, the existing mode rules apply; nothing gets automatically approved by an outage. An explicitly configured backup's allow is trusted even in `strict` mode.

With backups, each model gets one provider attempt rather than the normal provider retry; an empty successful reply may still retry within that model's timeout. `timeoutMs` applies to each model unless its entry overrides it. The whole walk also has a budget ceiling (`max(2 × primary timeout, 30s)`, mirroring LiteLLM's 30s router timeout): each endpoint gets `min(its own timeout, remaining budget)`, and the walk stops once under 2s remain. Fallback entries default to `min(top-level timeoutMs, 10s)` (LiteLLM `request_timeout` convention — backups are usually cheap fast models); an explicit per-entry `timeoutMs` always wins. Without backups, a single endpoint keeps the provider's normal retry behavior, where `timeoutMs` bounds each attempt rather than the total. Backup verdicts are not cached, so the primary is retried on the next ask. Failover transitions appear as `ai_guard.fallback` review records without URLs, credentials, or provider error text. Every contacted model receives the permission request (including command text and target paths) plus stripped conversation context: choose providers you trust with that data and account for their costs.

`fallbacks` accepts either lane in any order: each entry names a registry model (`{ "provider": "anthropic", "model": "..." }`), and a classifier fallback adds `"modelType": "classifier"`. A fallback whose model is missing from Pi's catalog is skipped with a warning, while an unresolvable primary fails the session (config not applied). A string `instructions` broadcasts the same appended content to both lanes; an object carries per-lane slots (`chat` / `classifier`) — see [Custom rules](#custom-rules). Configure a classifier primary with `"modelType": "classifier"`.

### Custom rules

`instructions` is one top-level field for both lanes; its default `null` runs the built-ins. A **string** broadcasts: the same text is appended to every lane's built-in instructions (a chat model's safety rules; the classifier's shared reviewer background).

```json
{
  "instructions": "This project never touches /etc or ~/.ssh; any action there is unauthorized."
}
```

An **object** carries per-lane slots. `chat.rules` holds the chat lane's text; `classifier.background` holds the classifier's shared background; `classifier.questions` adds per-question notes keyed by the stable question id (`ban`, `effect`, `target`, `intent` — an unknown id is rejected, not ignored). A lane with no slot runs its built-ins.

```json
{
  "instructions": {
    "chat": { "rules": "Deploys go through railway up." },
    "classifier": {
      "background": "Monorepo: each package owns its directory.",
      "questions": {
        "effect": "Deleting migration files counts as irreversible destruction."
      }
    }
  }
}
```

Only the `chat` slot takes `replace: true`, which swaps the built-in safety-rules block for the slot's content instead of appending to it. The classifier lane is append-only: its built-in reviewer background, questions, and criteria are the answer contract the verdict policy presumes, so nothing there is replaceable. The verdict output format is likewise never replaceable, so a replacement can never change what the parser expects.

`classifier.background` is the classifier's **environment profile**: trusted, operator-authored facts the reviewer cannot derive from the request — monorepo layout, trusted remotes, expected cross-repo reads, prod-versus-local scope. It is where you say a dependency outside the working directory is routine:

```json
{
  "instructions": {
    "classifier": {
      "background": "This repo is a pi extension that depends on the pi-mono monorepo; reading sibling packages under the workspace is expected."
    }
  }
}
```

The reviewer never reads repository files (`package.json`, `README`, `AGENTS.md`) into its prompt — repository content is untrusted, and a poisoned description must not widen its own authorization. Environment facts belong in this trusted slot. It is not a permission grant: the background reaches every question, so it can shape how the model reads the anchor, but an unauthorized confident danger hit still denies — an authorized or unsure one confirms with you instead.

The example above assumes the pool has both a chat and a classifier reviewer, so a chat-only pool writes just `chat`.

A slot whose lane no configured reviewer declares is rejected (it would silently do nothing); a lane declared only by a fallback can still go unused if that fallback is later skipped, which the loader reports. A lane the object leaves out keeps its full built-ins — also reported as a notice, so a half-covered pool is never silent.

### Classifier reviewer

Set `"modelType": "classifier"` on a `provider` that Pi knows about to run the reviewer through Pi's built-in classifier (`{ "provider": "typesafe", "model": "jev-latest", "modelType": "classifier" }` — no API key in config, auth lives in Pi; needs pi 1.0+). Pi ships a TypeSafe provider, and a System One-compatible endpoint — OpenRouter, Command Code's Provider API, a compatible local server — can be registered as a custom Pi classifier provider. The endpoint's model must be in Pi's catalog before AI Guard can use it: a classifier primary missing from the catalog fails the session, a missing classifier fallback is skipped. The overlay format is identical.

| Field                 | Default | Description                                                                                     |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `confidenceThreshold` | `0.5`   | Minimum confidence at which a reading is adopted; below it that axis takes its uncertainty path |

The primary reviewer's timeout is the top-level `timeoutMs`, for the classifier lane exactly as for chat; a backup overrides it with its own entry-level `timeoutMs`.

`confidenceThreshold` is the minimum confidence at which a classifier reading is adopted: below it, that axis takes its uncertainty path. It compares the model's returned `confidence` — the label distribution's peak concentration — and does not measure evidence completeness; a `ban` reading of `unestablished` is a separate, explicit mechanism. An unreadable `effect` asks neutrally; every other non-release asks leaning deny, except a `plain` base without a named request, which asks leaning allow. A response missing a reading is malformed and routes to a machinery defer (never allow); missing confidence reads as untrusted (adopted nowhere). The rows are listed in [Policy](docs/policy.md).

`instructions` appends in this lane — see [Custom rules](#custom-rules).

#### Backup classifier models

If your primary classifier runs out of quota, drops a model, or becomes unavailable, set `fallbacks` to an ordered list of other models registered in Pi. Each backup names its Pi `provider` and `model` and may set its own `timeoutMs`. A backup may be in either lane:

```json
{
  "provider": "typesafe",
  "model": "jev-1.13",
  "modelType": "classifier",
  "fallbacks": [
    { "provider": "anthropic", "model": "claude-haiku-4-5", "modelType": "chat" },
    { "provider": "typesafe", "model": "jev-latest", "modelType": "classifier", "timeoutMs": 3000 }
  ]
}
```

Failover semantics are the same as the chat lane above: availability failures switch, decided verdicts stop and ask, nothing is approved by an outage. A backup's valid allow counts as a reviewer allow **even in `strict` mode** — configuring it is trusting it to decide when the primary cannot. Backup decisions are not cached, and every contacted model receives the request plus stripped context: trust the provider with that data, and test a local model's probability scales before trusting its thresholds.

With backups configured, each endpoint gets one request rather than the transport's normal retries. Timeouts apply **per endpoint**, so set the top-level `timeoutMs` (the primary) and each backup's optional `timeoutMs` low enough for an acceptable worst-case wait.

### Mode

The reviewer model answers each permission ask with `allow`, `deny`, or `defer` (uncertain); `deny` carries a `riskLevel` (audit only — it never changes how the deny is disposed), and `defer` may carry a `lean` — the reviewer's directional inclination ("if forced to pick now, I'd allow/deny"; omitting it means genuinely neutral). The ladder disposes every verdict by **suspicion order** — from most benign to most dangerous:

```
allow  <  defer (lean: allow)  <  defer (neutral)  <  defer (lean: deny)  <  deny (model)  <  deny (screen)
```

Each mode is two cut lines on that order — an auto-pass band, an ask band, a terminal-deny band. The full matrix:

| Verdict ↓ (suspicion ↑)         | `strict` | `default` | `auto` |
| ------------------------------- | -------- | --------- | ------ |
| `allow`                         | allow    | allow     | allow  |
| `defer` + `lean: allow`         | deny     | ask       | allow  |
| `defer` (neutral)               | deny     | ask       | allow  |
| `defer` + `lean: deny`          | deny     | ask       | deny   |
| `deny` (model, any `riskLevel`) | deny     | ask       | deny   |
| `deny` (deterministic screen)   | deny     | deny      | deny   |

The reading per mode: `strict` — the reviewer's allow is the only pass (full fail-closed automation); `default` — you judge every flag except the screen's hard blocks (the resting mode and the onboarding posture — watch the reviewer work, then loosen); `auto` — no prompt is ever raised: only benign and neutral doubts pass; a deny-leaning doubt or a deny is blocked, because auto has no ask path (a danger confirmation never auto-flows into an allow). `auto` is not the yolo mode of Codex (`--yolo`), Claude Code (`bypassPermissions`), or Gemini CLI (`yolo`): those neither ask nor block, while `auto` still blocks every deny and every danger-leaned doubt. `lean` routes a defer between the middle rungs (in `auto` it decides between allow and deny); it never appears in dialogs or notify lines (the ask is the human's judgment moment) — it lives in the `ai_guard.decision` audit record.

`custom` runs your own ladder row instead of a built-in one:

```json
{
  "mode": "custom",
  "customMode": {
    "allowThrough": "defer-benign",
    "denyFrom": "hard-deny",
    "onReviewFailure": "defer",
    "onIrreversibleEffect": "defer"
  }
}
```

The example above passes only benign-leaned doubts, asks on everything up to a hard deny, defers reviewer failures to you, and asks on proven-irreversible effects — the closest expressible neighbour of the retired `lenient` rung. The vocabulary is the suspicion order's rung names (`allow`, `defer-benign`, `defer-neutral`, `defer-danger`, `soft-deny`, `hard-deny`); `onReviewFailure` is `deny` or `defer`, never `allow` — a broken reviewer must not rubber-stamp, whatever the cuts say. `onIrreversibleEffect` is its own axis, not a rung on that line: `defer` asks (what every built-in rung does), `allow` passes the class of effect you accept, `deny` blocks it. A mode is two boundaries plus two lanes, so a custom row is contiguous by construction: there are no per-rung cells to set incoherently, and an accept line at or above the reject line is legal (the mode simply never asks — allow wins the overlap). A row that redraws a built-in rung exactly, floor ruling included, is reported as redundant, with the rung to use instead.

`custom` is only selectable while `customMode` configures it: the picker and the casual cycle hide it otherwise, and `mode: "custom"` with no block runs `default` and reports a config issue saying so (repair, not refusal — a mode choice never takes the guard offline). The `ctrl+alt+g` cycle visits a configured `custom` last, and the footer renders it in warning red exactly when it never asks — the same derivation as the built-in ask-free rung, so an allow-everything custom cannot hide. An unconfigured `custom` left in the session file restores as nothing.

The classifier lane reaches the same five verdicts through its decision table, so the mode matrix above applies unchanged. What the table emits depends on the readings ([Policy](docs/policy.md) lists the rows):

| Reading                                                    | Verdict               |
| ---------------------------------------------------------- | --------------------- |
| a trusted `ban` of `forbids`                               | deny (model)          |
| `ban` of `unestablished` (or an untrusted hit)             | defer + `lean: deny`  |
| `effect` unreadable                                        | defer (neutral)       |
| `free` base                                                | allow                 |
| `plain` or `guard` base, named request, no escalating fact | allow                 |
| `plain` base, no named request                             | defer + `lean: allow` |
| `guard` base with no release                               | defer + `lean: deny`  |

An escalating fact lifts a `plain` base to `guard`, so a named request still asks. A `block` base defers leaning deny with `riskLevel: critical`.

A separate deterministic rule covers the reviewer's allow: when the command facts prove an irreversible effect (a history rewrite, a recursive delete outside the working directory, a persistence install, an all-interfaces listener, credential-shaped data handed to a sender, a raw block copy), the allow cannot pass silently. Every built-in rung asks; a `custom` row disposes it by its own `onIrreversibleEffect` (`allow`, `defer`, or `deny`), and the record names the facts and the ruling. The deterministic screen's hard deny stays terminal regardless of that choice.

A model deny never binds: it is soft whatever its `riskLevel`, so `default` asks you and `strict` and `auto` deny. Only the deterministic screen hard-denies, in every mode, before any model call. It holds a closed list of shapes no request makes right, wherever in the command they appear: recursive deletion of a system root or drive root (`rm`, `rimraf`, `del`, `trash`), raw device writes and wipes (`dd of=`, `mkfs`, `shred`, `blkdiscard`, `nvme format`, `cp` or `tee` onto a block device), destructive partition and volume commands, setuid chmod, force-push to a protected branch, reverse shells, a download piped into an interpreter or evaluated as a program, a function that backgrounds a pipeline of itself, `find … -delete` from a system root, and `kill … -1`.

Everything else reaches the reviewer model, including shapes a request can legitimately want: rewriting the sudoers file, clearing every cron job, recursive ownership changes under a system root, rebooting the host, interactive partition editors, `mount`, `history | sh`, ordinary file deletion and truncation, killing named processes, firewall and routing changes, and destructive git operations outside a protected force-push. A shape the screen cannot prove — anything carrying a variable or a substitution, an interpreter's own program text (`python3 -c`, `node -e`, a script file), a `find` action that runs a command, an alias body (a shell expands an alias only when the definition precedes the line being read and expansion is enabled), PowerShell, an option it does not model — is never denied there: it is a model decision, and the screen never guesses at text it cannot read.

Rules that hold in every mode:

- Reviewer machinery failures (model unresolved, auth failed, transcript errors, timeouts, unparseable or empty replies, no review target) **never map to allow**; they deny under `strict` and `auto`, defer under `default`, and follow the custom row's `onReviewFailure` under `custom`. A machinery deny stays silent (the deny reason reaches the agent); a machinery-forced defer notifies its classified cause (`reviewer could not complete the review (empty-reply), deferring to you`), on every occurrence.
- A model deny that holds or escalates notifies in every mode (`reviewer denied this request (risk high); <reason>`), because the host renders no dialog for denials; the notify line is the operator's only copy. A mode-softened deny adds `, asking you to decide instead`. `auto` passes benign-leaned defers silently and neutral ones with a one-time fail-open notice (`this mode allows the request without asking; a danger-leaned doubt and every deny still block`), fired the first time it passes a doubt the reviewer did not resolve to allow. Reasons go out whole; the audit record keeps the full text.
- The lean never caches: defers are never stored, so an identical benign defer re-reviews every time.
- A link's `deny` is final — it short-circuits the chain and never reaches a prompt. A `defer` falls through to the interactive permission prompt (the denying terminal in headless sessions — headless mode collapses every defer to deny).
- `strict`'s one exception: a breaker forced to `defer` still reaches the human (the reviewer-untrusted escape valve); headless sessions resolve those defers to deny either way. `auto`'s first mapped allow surfaces a one-time notice; the footer renders the value in warning red.

Set `"notifyApprovals": true` to see when AI Guard approves a request. Fresh reviews show their total cost (`reviewer approved this request (1.2s)`; mode-mapped allows name the mode), cache replays say `(cached)`. Notices never include the command or target. Off by default.

Ambient (review-loop) notices respect the `notifyLevel` threshold: `info` (default) passes everything, including opted-in approval notices; `warning` silences approval notices and the clarification notice (the dialog still pops); `error` keeps only the total-tier breaker trip; `off` silences every ambient line. **Command feedback and guard-absent errors are never gated** (a fail-safe config start, a failed registration, and a stale registration are always error grade). The tradeoff of `warning`/`error`/`off`: model denies and clarifications reach only the agent and the audit log, an operator-owned risk.

Mapped verdicts still count toward the breaker and still store in the cache (the mapping re-applies on every cache hit); defers are never cached — lean-derived allows included.

### Runtime control

Effective config layers, in precedence order: **session overrides** (the controls below) > **project config** (trusted projects) > **global config**. Saving writes UPWARD into a layer; a saved field then shadows the layers beneath it.

- `/ai-guard` — the settings menu (settings, save, breaker, and the report/denied panels are all menu rows); direct forms `/ai-guard mode <v>`, `/ai-guard notify-level <v>`, `<setting> reset` (a setting's verb is its config field's kebab form — the command shape used across pi's built-ins; menus show the phrase form, `notify level`).
- `/ai-guard save-config <global|project>` (a bare `save-config` opens a target picker) — persist the current EFFECTIVE config (session overrides included) into a config layer via JSONC-preserving edits (project target refused for untrusted projects). New sessions start from the saved layer; the current session keeps its overrides; a higher-precedence layer can still shadow it.
- `/ai-guard breaker reset` — clear both trip tiers. Pure counter reset: cache and overrides untouched; reviews resume immediately.
- `/ai-guard report` — suggest permission-rule fragments for repeatedly-reviewed asks (same ask 3+ times, one context, no denies) — copy-paste evidence, never an applied rule.
- `/ai-guard denied` — browse this session's model denies; pick one to see its full reason.
- `ctrl+alt+g` — cycle `default → auto → default` (`custom` joins last while configured). Only `strict` stays out of casual reach.

The footer shows deviations from the baseline only (`off · auto (session)`) and renders `auto` in warning red, so a silenced pane stays visible. Overrides persist per session in pi's session file (never model context): resume restores them, `/tree` navigation re-derives from the active branch, and a fresh session starts from the config default.

### Circuit breaker

Two-tier, fail-safe:

- `circuitBreaker.consecutive` — **recoverable** tier: when a deny streak hits the threshold, the breaker trips, returns `circuitBreaker.verdict`, and resets the consecutive counter so the model gets another chance on the next ask.
- `circuitBreaker.total` — **hard** tier: once a session accumulates that many model denials, the breaker stays tripped permanently (the counter never resets on its own — only `/ai-guard breaker reset` or a session restart clears it). Together they tighten progressively — repeated abuse walks a recoverable trip toward the permanent one.

A heavy session can legitimately reach the hard tier (a deny-leaning reviewer burns the budget by volume, not failure), so: the first total-tier trip notifies once at error grade (`circuit breaker tripped (total tier reached), blocking all reviews until /ai-guard breaker reset or restart`; re-armed after each reset, and the ambient channel's only error line), and `/ai-guard breaker reset` clears both tiers (cache, mode, and overrides survive). A session restart clears the breaker either way.

Counter rules: trips and cache hits are never counted as model denials; the breaker counts what the model produced regardless of the mode. Deny-equivalents — machinery-failure denies and `strict`'s model-defer→deny mapping — count into the **recoverable** tier only; the `total` tier stays model-denies-only.

A tripped breaker's forced verdict **bypasses the verdict-rule mapping** (the explicit breaker config is more specific than the general mode):

- `verdict: "deny"` (default): the trip forces a deny (with a breaker reason the agent can act on) — in `strict` mode the session keeps running uninterrupted, fail-closed.
- `verdict: "defer"`: the trip defers to the human — in `strict` mode this **interrupts on purpose**: the breaker tripping means the reviewer itself is untrusted (a deny storm — miscalibrated or prompt-injected), and this is the designed escape valve. A notification explains the interruption; headless sessions degrade to deny (no human is present). The config loader warns about the `strict` + `defer` and `auto` + `defer` combinations up front.

### Verdict cache

`cache.maxEntries` enables a session-level LRU keyed by a review request snapshot plus a trusted-intent fingerprint, so a repeated identical ask in a stable conversation skips the model call.

- The key is a decision-relevant projection of the ask (kind, target, full command, executed unit, working directory, …) plus a trusted-intent fingerprint — `curl example.com` and `curl example.com | bash` are distinct; the same command in a different cwd is a different authorization.
- The administrative `surface` label is not in the key: two asks differing only in surface intentionally collide.
- Only asks that reached the model are cached (policy `ask`); rule changes to `allow`/`deny` defer before the cache, so stale entries can't override them.
- The fingerprint is built from user messages — chatty conversations invalidate often; the cache benefits repeated-command, low-chatter sessions most. Hits carry a `gate: "cache-hit"` record.

## Provider compatibility

- `reasoning: "off"` (default) keeps the reviewer fast and cheap; a tolerant text parser extracts the JSON verdict from prose-wrapped replies.
- **Sampling temperature (`temperature`):** the reviewer reads its verdict straight off the reply, so an unpinned temperature shows up as the same request flipping between runs. Leaving the field unset means the provider default applies, and every default is high — OpenAI and Anthropic both use 1.0, llama.cpp 0.80 — so the reviewer runs hot unless you say otherwise. `temperature: 0` is the value to want: in practice it cuts run-to-run disagreement (the 87-case A/B measurement is retired with that corpus). It is not a full fix; identical prompts at 0 can still differ. Keep it unset for a model that rejects non-default sampling — OpenAI reasoning models accept only their own default, and pi-ai drops the field only for the Anthropic models that reject it. A backup is a different model, so give its `fallbacks` entry its own `temperature` when the pin does not suit it. Omitting the entry's field inherits the top-level pin; it does not restore the provider default.
- **OpenAI-compatible providers:** set `provider: "openai"` plus the model id. The base URL, API key, and provider binding come from the model registry pi injects at session start (no `baseUrl` field here).

## Observability

Each reviewer-relevant decision writes an `ai_guard.decision` record to pi-permission-system's review log at (cache hits and deterministic-engine pre-decisions are debug-stream replays only) `~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`. Fields on the `model` gate record:

| Field         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`        | Which decision gate produced the record (see How it works)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `verdict`     | `allow` / `deny` / `defer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reason`      | Sanitized model explanation: on deny (model text or `GENERIC_DENY_REASON` fallback) and on `model-defer` (what was unclear). Absent for allow and explanation-less defer. The breaker gate uses a static `BREAKER_DENY_REASON` instead                                                                                                                                                                                                                                                                                                                                                                  |
| `deferKind`   | Why it deferred (classification). Model-gate: `empty-reply` (a completed reply without text — genuine model silence), `no-json` (text present but no JSON found), `timeout` (per-call timeout elapsed), `call-failed` (the call threw, or a provider error resolved as a non-thrown reply — rate limits, proxy/WAF blocks; classifier 429s retry inside Pi only when no backups are configured), `model-defer`, `invalid-verdict-value`. Other gates: `circuit-breaker`, `model-unresolved`, `auth-failed`, `no-target`, `transcript-error`, `policy-allow`, `policy-deny`. `null` for clean allow/deny |
| `latencyMs`   | End-to-end model-call latency (cumulative across attempts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `attempts`    | Present (`2`) only when the empty-reply retry fired; absent on single-attempt reviews                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `modelId`     | `provider/model` of the reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rawReply`    | Three states: the raw model text for defer paths that produced one (`no-json` / `invalid-verdict-value` / `model-defer`), elided in the middle past 2000 characters before storage; `null` for `timeout` / `call-failed` / `empty-reply` (no text was produced); `"(clean verdict, rawReply omitted)"` for allow/deny where the parsed JSON is already in structured fields (`verdict`, `reason`, `riskLevel`)                                                                                                                                                                                          |
| `riskLevel`   | Model-assessed risk (`low`/`medium`/`high`/`critical`), or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `contextHash` | Trusted-intent context fingerprint (same value as the verdict-cache key's context hash) — distinguishes same-context repetitions from cross-context ones                                                                                                                                                                                                                                                                                                                                                                                                                                                |

When a classifier endpoint or chat-model provider fails and another endpoint is available, `ai_guard.fallback` writes a separate review-stream record for the transition (`failedEndpoint`, `nextEndpoint`, `modelId`, `reason`). Endpoint positions are zero-based (primary = 0); the record omits URLs, API keys, and provider error bodies. Each transition is logged alongside the final `ai_guard.decision` record.

Supplementary debug records (written via `log.debug`, gated by the upstream log level):

- `ai_guard.model_reply` — raw model text on defer-with-text replies; also fires with `diagnostic: true` on empty responses (`stopReason`, `rawStopReason`, `contentTypes`, `errorMessage`, `latencyMs`; `stopReason: "aborted"` = the timeout elapsed, classified `timeout` not `empty-reply`).
- `ai_guard.cache_lookup` — cache misses with a `missReason` (`disabled` / `no-entry` / `context-changed`).
- `ai_guard.model_call_error` — thrown model calls, recording the `deferKind` (`timeout` / `call-failed`) and error message.
- `ai_guard.model_answers` — the classifier lane's per-question answers on every verdict. Clean verdicts keep only a sentinel in the decision record, so this is the one source a policy replay can re-score without another paid pass.

## License

MIT
