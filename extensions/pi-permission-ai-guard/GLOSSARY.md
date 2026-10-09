# pi-permission-ai-guard

A Pi extension that reviews permission asks with a light model, using a token-optimized stripped transcript. The doctrine for writing the safety-rules prompt lives in [docs/prompt-principles.md](./docs/prompt-principles.md).

## Language

### The ask

**Ask**:
A permission request submitted to the authorizer chain: a shell command, a tool call, or a skill invocation.
_Avoid_: request, prompt (reserved for model prompts)

**Surface**:
The tool type an ask targets (`bash`, `mcp`, `skill`, or a namespaced tool name like `my-ext:tool`). The first eligibility gate.
_Avoid_: tool, command (a surface is the type, not the specific invocation)

**Review target**:
The value being authorized (the command string, tool name, path). Resolved together with the surface; if no target can be extracted, the ask is not reviewable.

**Ask eligibility**:
Whether an ask qualifies for AI review — the surface matches the configured list and a review target can be extracted.

### Verdicts

**Policy gate**:
The deterministic engine queried before the model. When the policy already says `allow` or `deny`, the link defers; it only adds value on an undecided (`ask`) policy.

**Verdict**:
The link's ruling: `allow`, `deny` (with an optional teaching reason), or `defer`.

**Defer**:
The fail-safe outcome — a missing model, invalid config, timeout, unparseable reply, or unsure verdict all defer, falling through to the normal permission prompt.

**Lean**:
The reviewer's directional inclination on a defer (`allow`, `deny`, or omitted for neutral). A routing signal only: it selects the defer's band in the mode ladder and never surfaces to the human.
_Avoid_: treating the lean as the verdict

**Suspicion order**:
The total order the mode ladder is drawn on: `allow` < defer-by-lean < soft deny < hard deny. Each mode is two cut lines on this order, so the auto-pass, ask, and terminal-deny bands stay contiguous in every mode.

**Mode**:
The leniency ladder for the reviewer's non-allow verdicts, strictest first: `strict`, `default`, `lenient`, `permissive`. Hard-tier denies are terminal in every mode; soft-tier denies and the model's doubts map against the ladder.
_Avoid_: mode as a verdict source (the model's judgment is always recorded; the mode maps only what the link emits)

**Hard tier / Soft tier**:
The deny split by risk. A hard-tier deny (risk level high, critical, or missing) is terminal in every mode; a soft-tier deny (low or medium) maps against the ladder.

**Reviewer machinery failure**:
A failure to obtain any verdict — unresolved model, auth failure, transcript error, timeout, unparseable or empty reply, no review target. It never maps to allow in any mode; it denies under `strict` and `permissive`, and defers otherwise.

### Session state

**Node**:
One session runtime with its own permissions service and lifecycle. The root session and every in-process subagent child run as separate nodes; a branch or rewind within a session is still the same node.

**Circuit breaker**:
The per-session, two-tier, fail-safe limiter on reviewer denials: `consecutive` trips after N consecutive denials and then resets, `total` never resets on its own.

**Verdict cache**:
A per-session LRU keyed by a decision-relevant projection of the ask and a trusted-intent fingerprint. A repeated identical ask in a stable conversation skips the model.

**Deny history**:
The session-memory list of what the reviewer itself refused, read by `/ai-guard denied`. Model-gate denies only — mapping artifacts and machinery denials are absent by design.

**Command entry table**:
The single table behind the `/ai-guard` command, one row per first token. Completion, the settings menu, and dispatch all traverse it, so adding a verb is one entry.

### Review

**Lane**:
One reviewer implementation class: `chat` (a Pi chat model's text verdict) or `classifier` (calibrated probabilities). It is an endpoint's identity, not a transport.
_Avoid_: calling a mode-ladder band a lane

**ReviewerEngine**:
The review-outcome producer seam. One pooled supervisor walks an ordered, heterogeneous endpoint list through one per-lane adapter each.

**TypeSafe vs Jev**:
Two independent axes. **TypeSafe** is the transport/provider surface (SDK client, wire shapes, provider value, env fallbacks). **Jev** is the model strategy (question set, calibration, overlay, verdict synthesis).

**Model call path**:
The chat lane's route through `ModelRegistry.streamSimple` — the agent's own call path. Never the provider layer directly.
_Avoid_: provider-layer calls

**Pi version floor**:
The runtime Pi version each lane needs — chat `≥ 0.86` (`streamSimple`), registry-classifier `≥ 0.99` (`classify`/`findOfType`, admission-gated). The source targets the 0.99 type surface for maintainers; Pi erases types at load, so a 0.86 host runs the chat lane unaffected.

**Lane fact inventory**:
The cross-lane contract for ask facts (`tests/review/lane-facts.ts`): every `AskContext` / `PromptRequestFacts` field classified per lane as rendered (with its name and encoder) or excluded (with a reason). Exhaustive by construction, so a new upstream fact stops compilation until both lanes decide. It pins presence, not presentation — the lanes fork deliberately on some encodings (chat words vs classifier raw `commandContext`; chat-redacted vs verbatim cwd).

**Full review**:
The JSON-verdict review: the model receives a stripped transcript plus the permission request and returns a verdict, reason, and risk level. A tolerant parser extracts the JSON from prose-wrapped replies.

**Upstream retry**:
One retry per mechanism per review, budgeted inside the total timeout, so a review never exceeds one window.

**Operator notices**:
The notify-line doctrine: all lines go through the notify seam, split into the ambient channel (gated by the effective `notifyLevel`) and the feedback channel (never gated).

**Ask context**:
The structured projection of a permission ask that the review feeds the model — a kind-dispatched projection of the facts that can change a verdict, with evidence pre-resolved into named fields.

**Decision record**:
The audit-log entry emitted at each decision gate, split into the review stream (always on) and the debug stream (only while the permission system's debug log is on).

**Disposition**:
The single release seam for every gate that emits a verdict. The gate declares verdict and facts; the disposition owns the release ritual.
_Avoid_: escalation footwork

**Policy suggestion**:
A report candidate for a deterministic permission rule: the same ask reached the model at least three times, each occurrence in one trusted-intent context, never refused by either side. Evidence, never authorization.

### Transcript

**Stripped transcript**:
A token-optimized transcript fed to the model: trusted user messages and tool-call names+args kept; assistant text, tool results, and compaction summaries deleted.

**Trusted intent**:
The user-message portion of the stripped transcript — the only authorization source the model honors, with the latest message as the authorization anchor.
