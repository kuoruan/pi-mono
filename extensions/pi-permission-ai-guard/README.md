# pi-permission-ai-guard

A [Pi](https://github.com/earendil-works/pi) extension that reviews permission asks with a light model, using a **token-optimized stripped transcript**.

It is a consumer of [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages): it registers an `"ai-guard"` chain link that reviews `ask`-level permission requests across all configured surfaces (bash, mcp, skill).

## Why

Each model review call sends **only stripped context** (user messages + tool call names), not the full transcript. This substantially reduces token consumption by discarding assistant text and tool results — the token-heaviest parts of a transcript — with minimal impact on verdict quality.

## How it works

The reviewer runs a short, cheap decision on each ask and defers at the first miss:

1. Surface match: the ask's surface is in `surfaces` (otherwise defer).
2. Extract the review target (the value being authorized).
3. Policy gate: query the deterministic engine at gate parity — if the policy
   already says `allow` or `deny`, defer. This link only adds value when the
   engine is undecided (`ask`).
4. Circuit breaker: a tripped breaker short-circuits without a model call.
5. Resolve model + auth.
6. Strip transcript (token-optimized): the stripped transcript feeds both the
   verdict cache's context fingerprint and the model review prompt.
7. Verdict cache lookup: a repeated ask in a stable conversation hits the
   cache and skips the model.
8. Build prompt (redaction happens here — credentials in the command/intent
   are scrubbed before the prompt is built).
9. Model review: JSON verdict.
10. Record the verdict into the breaker counters and cache.

Fail-safe by construction: a missing model, invalid config, model timeout, unparseable reply, or an unsure verdict all resolve to `defer`. This list is representative, not exhaustive — any unexpected error path also defers. Deferring means the ask falls through to the normal permission prompt.

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

Two config files are involved: pi-permission-system's config names the chain link, and this extension's config declares the model and review behavior.

1. In **pi-permission-system** config, name the link in `authorizerChain`:

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-system/config.json
   { "authorizerChain": ["ai-guard"] }
   ```

2. In **this** extension's config, declare the model and review behavior:

   ```jsonc
   // ~/.pi/agent/extensions/pi-permission-ai-guard/config.json
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

> **Where to put hard-deny rules:** secrets, dangerous commands, and safe
> auto-allow patterns belong in **pi-permission-system's** rule config (deny /
> allow rules), not in this extension. The AI-guard link only runs the model
> when the deterministic engine is undecided (`ask`) — it queries the engine
> at gate parity and defers whenever the engine already decided `allow` or
> `deny`. Configure `.env`/`~/.ssh`/`rm -rf` style blocks as
> pi-permission-system rules so the chain (and this link) honors them without
> a model call.

## Configuration

| Field            | Type                             | Default                                   | Description                                                            |
| ---------------- | -------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `provider`       | string                           | required                                  | Model provider (e.g. `anthropic`)                                      |
| `model`          | string                           | required                                  | Model id (e.g. `claude-haiku-4-5`)                                     |
| `reasoning`      | `"off"\|"low"\|"medium"\|"high"` | `"off"`                                   | Thinking level; `off` = disabled                                       |
| `timeoutMs`      | integer                          | `15000`                                   | Model-call timeout (ms)                                                |
| `transcript`     | object                           | see below                                 | Transcript stripping config (see below)                                |
| `surfaces`       | string[]                         | `["bash","mcp","skill"]`                  | Surfaces to review; glob patterns (`*`, `ns:*`, `*:bar`); `!` excludes |
| `instructions`   | string\|null                     | `null`                                    | Custom safety rules (replaces defaults; null = built-in)               |
| `circuitBreaker` | object                           | `{consecutive:3,total:20,verdict:"deny"}` | Circuit breaker config (see below)                                     |
| `cache`          | object                           | `{maxEntries:128}`                        | Verdict cache (see below)                                              |

### Transcript

Controls how much context is kept for the model review. Only trusted user
messages (including `ask_user_question` answers) and tool call names+args
are kept; assistant text, tool results, and compaction summaries are
stripped.

| Field              | Default | Description                              |
| ------------------ | ------- | ---------------------------------------- |
| `maxUserMessages`  | `5`     | Max trusted-intent entries (most recent) |
| `maxToolCalls`     | `10`    | Max tool calls (most recent)             |
| `maxCharsPerEntry` | `1000`  | Truncate each entry to this many chars   |

### Circuit breaker

Two-tier, fail-safe. `circuitBreaker.consecutive` is a **recoverable** tier:
when a deny streak hits the threshold, the breaker trips, returns
`circuitBreaker.verdict`, and resets the consecutive counter so the model
gets another chance on the next ask. `circuitBreaker.total` is a **hard**
tier: once a session accumulates that many model denials, the breaker stays
tripped permanently (the counter never resets). Together they tighten
progressively — repeated abuse walks a recoverable trip toward the
permanent one. Breaker trips and cache hits are not counted as model
denials (no double-counting).

### Verdict cache

`cache.maxEntries` enables a session-level LRU keyed by a review request
snapshot (a decision-relevant projection of the ask — kind, review target,
full command, flagged elements, command context, executed unit, canonical
boundary, working directory, and the tool-input/read-path/resolved-alias
slots) plus a trusted-intent fingerprint, so a repeated identical ask in a
stable conversation skips the model call. `curl example.com` and `curl
example.com | bash` are distinct entries (different `executed unit`).
Working directory is part of the identity — the same command in a
different directory is a different authorization (e.g. `rm -rf build` resolves
differently per cwd). The gate label `surface` is **not** part of the key —
it is an administrative label the model is told to ignore, so two asks
sharing kind + content but differing only in surface reach the same verdict
and intentionally collide. The cache only applies to commands that reached
the model (policy `ask`); a rule change to `allow`/`deny` defers before the
cache, so stale entries can't override rule changes. **Caveat:** the context
hash is built from trusted user messages, so conversations that interject
frequently invalidate entries often — the cache benefits "high-frequency
repeated commands, low-chatter" sessions most. Cache hits carry a `gate:
"cache-hit"` log entry for debugging.

## Provider compatibility

- `reasoning: "off"` (default) — thinking is disabled, keeping the reviewer fast and cheap.
- The model is prompted to respond with a JSON verdict object; a tolerant text parser extracts the verdict from the reply, so providers that wrap JSON in prose still work.
- Token optimization targets raw token minimization (stripped transcript), not prompt-cache hits — works regardless of provider caching support.
- **OpenAI-compatible providers:** set `provider: "openai"` and the model id in config. The base URL, API key, and provider binding come from the model registry that pi injects at session start, not from this extension's config — there is no `baseUrl` field. Validate an OpenAI-compatible endpoint end-to-end with `npx tsx scripts/integration-test.ts --provider openai --base-url <url> --api-key <key>`.

## Observability

Each decision writes an `ai_guard.decision` record to pi-permission-system's
review log at
`~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`.
Fields on the `model` gate record:

| Field       | Meaning                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`      | Which decision gate produced the record (see How it works)                                                                                                                                                                                                                                                                                                                                  |
| `verdict`   | `allow` / `deny` / `defer`                                                                                                                                                                                                                                                                                                                                                                  |
| `reason`    | Sanitized model explanation. Present on deny (from the model, or `GENERIC_DENY_REASON` fallback) and on `model-defer` (what the model found unclear). Absent for allow and defer-without-explanation. The circuit-breaker gate uses a static `BREAKER_DENY_REASON` instead                                                                                                                  |
| `deferKind` | Why it deferred (classification). Model-gate: `empty-reply` (completed non-aborted reply without text), `no-json` (text present but no JSON found), `timeout` (per-call timeout elapsed), `call-failed` (call threw), `model-defer`, `invalid-verdict-value`. Other gates: `circuit-breaker`, `model-unresolved`, `auth-failed`, `policy-allow`, `policy-deny`. `null` for clean allow/deny |
| `latencyMs` | End-to-end model-call latency                                                                                                                                                                                                                                                                                                                                                               |
| `modelId`   | `provider/model` of the reviewer                                                                                                                                                                                                                                                                                                                                                            |
| `rawReply`  | Three states: the raw model text for defer paths that produced one (`no-json` / `invalid-verdict-value` / `model-defer`); `null` for `timeout` / `call-failed` / `empty-reply` (no text was produced); `"(clean verdict, rawReply omitted)"` for allow/deny where the parsed JSON is already in structured fields (`verdict`, `reason`, `riskLevel`)                                        |
| `riskLevel` | Model-assessed risk (`low`/`medium`/`high`/`critical`), or `null`                                                                                                                                                                                                                                                                                                                           |

Supplementary debug records (written via `log.debug`, gated by the
upstream log level):

- `ai_guard.model_reply` — the raw model text whenever the review produces
  one (clean verdicts and defers-with-text). Also fires with a
  `diagnostic: true` flag on empty model responses, capturing `stopReason`,
  `rawStopReason`, `contentTypes`, `errorMessage`, and `latencyMs`. A
  `stopReason: "aborted"` indicates the per-call timeout elapsed (the
  provider resolves an empty message rather than throwing) — these are
  classified as `deferKind: "timeout"`, not `empty-reply`.
- `ai_guard.cache_lookup` — emitted on cache misses with a `missReason`
  (`disabled` / `no-entry` / `context-changed`). Cache hits are covered by
  the `cache-hit` decision record and do not emit a duplicate debug event.
- `ai_guard.model_call_error` — emitted when a model call throws, recording
  the `deferKind` (`timeout` / `call-failed`) and error message.

## License

MIT
