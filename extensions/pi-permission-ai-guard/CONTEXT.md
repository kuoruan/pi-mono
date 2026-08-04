# pi-permission-ai-guard

A Pi extension that reviews permission **asks** with a light model, using a
token-optimized stripped transcript. This file pins down the ubiquitous
language so reviews, navigators (human or AI), and future contributors share
one vocabulary.

## Language

### The ask

**Ask**:
A permission request submitted to the authorizer chain. The thing being
reviewed: a shell command, a tool call, a skill invocation.
_Avoid_: request, prompt (reserved for model prompts)

**Surface**:
The tool type an ask targets (`bash`, `mcp`, `skill`, or a namespaced tool
name like `my-ext:tool`). The first eligibility gate.
_Avoid_: tool, command (a surface is the type, not the specific invocation)

**Review target**:
The value being authorized (the command string, tool name, path, etc.).
Resolved together with the surface; if no target can be extracted, the ask
is not reviewable.

**Ask eligibility**:
Whether an ask qualifies for AI review — the surface matches the configured
list AND a review target can be extracted.

### Verdicts

**Policy gate**:
The deterministic engine queried before the model. If the policy already
says `allow` or `deny`, the AI-guard link defers — it only adds value when
the policy is undecided (`ask`).

**Verdict**:
The link's ruling: `allow`, `deny` (with optional teaching `reason`), or
`defer` (pass to the next chain link).

**Defer**:
The fail-safe outcome. A missing model, invalid config, model timeout,
unparseable reply, or unsure verdict all defer. Deferring means the ask
falls through to the normal permission prompt.

### Session state

**Circuit breaker**:
Per-session, two-tier, fail-safe. `consecutive` is a recoverable tier
(trips after N consecutive denies, resets so the model gets another chance);
`total` is a hard session cap (never resets). Breaker trips are NOT counted
as model denials.

**Verdict cache**:
Per-session LRU keyed by an action identity (surface, review target,
working directory) plus a trusted-intent context fingerprint. A repeated
identical ask in a stable conversation skips the model. Working directory is
part of the action identity — the same command in a different directory is
a different authorization. Only commands that reached the model (policy
`ask`) are cached; defer is never cached.

### Review

**Full review**:
The JSON-verdict review. The model receives a stripped transcript + the
permission request and is asked to return
`{"verdict":"allow|deny|defer","reason":"...","riskLevel":"..."}`. A
tolerant parser extracts the JSON from prose-wrapped replies, so providers
that wrap JSON in text still work.

**Decision record**:
The audit-log entry emitted at each decision gate (policy-decided,
circuit-breaker, model-unresolved, auth-failed, cache-hit, model). Written
to `permission-review.jsonl` via the injected `AuthorizerLog`.

### Transcript

**Stripped transcript**:
A token-optimized transcript fed to the model. Keeps trusted user messages
(including `ask_user_question` answers and compaction summaries) and
tool-call names+args; deletes assistant text and tool results.

**Trusted intent**:
The user-message portion of the stripped transcript. The only authorization
signal the model is told to honor.

## External seams (upstream, immutable)

- `Authorizer.authorize(details, query, log): Promise<AuthorizerVerdict>`
- `AuthorizerLog { review(event, details?), debug(event, details?) }`
- `PermissionQuery { checkPermission, getToolPermission }`

All from `@gotgenes/pi-permission-system`. The extension registers an
`"ai-guard"` chain link via `service.registerAuthorizer`.
