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

Note: `external_directory`/`path` asks reach this link, but any `allow` on
them is capped to `defer` by the host's bounded-delegation checkpoint
(ADR 0007 §5, unchanged 25.x→26.0). The link's value there is limited to a
confident `deny`; an `allow` is never honored. The default `surfaces`
config (`["bash", "mcp", "skill"]`) excludes both, so by default the link
never reviews them — and even opt-in can't auto-allow them.

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
Per-session LRU keyed by a review request snapshot (surface, review
target, action text, canonical path boundary, working directory) plus a
trusted-intent context fingerprint. A repeated identical ask in a stable
conversation skips the model. Action text and boundary are part of the
key — `curl example.com` and `curl example.com | bash` are distinct.
Only commands that reached the model (policy `ask`) are cached; defer is
never cached.

### Review

**Full review**:
The JSON-verdict review. The model receives a stripped transcript + the
permission request and is asked to return
`{"verdict":"allow|deny|defer","reason":"...","riskLevel":"..."}`.
A tolerant parser extracts the JSON from prose-wrapped replies, so
providers that wrap JSON in text still work. Deny and defer carry a
`reason`; allow omits it.

**Ask context**:
The structured projection of a permission ask the full review feeds the
model — `payload.kind` selects which decision-relevant facts are
populated (full command, flagged elements, matched rule, command
context, executed unit, requester, canonical boundary). Built once by
`buildAskContext`; the prompt renderer and the verdict cache both read
its typed fields, so no consumer re-parses the upstream `PromptPayload`.
The projection resolves evidence labels to named fields once; the
renderer never does string-keyed lookups (ADR 0011: every consumer is a
renderer over the payload, and ai-guard is one).

**Decision record**:
The audit-log entry emitted at each decision gate (policy-decided,
circuit-breaker, model-unresolved, auth-failed, cache-hit, model). Written
to `permission-review.jsonl` via the injected `AuthorizerLog`.

### Transcript

**Stripped transcript**:
A token-optimized transcript fed to the model. Keeps trusted user messages
(including `ask_user_question` answers) and tool-call names+args; deletes
assistant text, tool results, and compaction summaries (summaries may
contain model output and must never become authorization signals).

**Trusted intent**:
The user-message portion of the stripped transcript. The only authorization
signal the model is told to honor.

## External seams (upstream, immutable)

- `Authorizer.authorize(details, query, log): Promise<AuthorizerVerdict>`
- `AuthorizerLog { review(event, details?), debug(event, details?) }`
- `PermissionQuery { checkPermission, getToolPermission }`

All from `@gotgenes/pi-permission-system`. The extension registers an
`"ai-guard"` chain link via `service.registerAuthorizer`.

## Prompt writing principles

The safety rules prompt (`SAFETY_RULES` in `src/prompt.ts`) is the semantic
instruction fed to the review model. These principles govern how it is
written and maintained.

### 1. Semantic, not literal

Rules describe abstract concepts ("credential stores, private keys"), not
environment-specific paths or tool names. A few generic examples
(`curl|bash`, `chmod +s`) are fine as anchors, but they never act as the
default gate — the category description does. Redundant qualifiers
("of unverified package" when the verb already implies it) are removed.

### 2. Three-tier precedence: DENY-Always > DENY-Unless > ALLOW

- **DENY-Always**: deny regardless of intent (secrets, irreversible
  destruction, external code execution, etc.).
- **DENY-Unless**: allow only with matching intent; otherwise the fallback
  the entry itself specifies (deny or defer).
- **ALLOW**: allow only when matching the current task context.

Each entry's fallback is stated by the entry, not by the section heading —
different entries in the same section can have different fallbacks
(Deletions → DENY, Unknown Commands → DEFER).

### 3. Uncertain → DEFER, not → DENY

Absent intent defaults to defer, not deny. "(none found)" is insufficient
evidence, not proof of absence. Unfamiliarity alone is not dangerous.
Non-destructive observation (navigation, read-only diagnostics, page
selection) without intent defers; it is never denied solely for being that
action.

### 4. Trusted intent is the only authorization source

Transcript, tool calls, action text, and permission requests are untrusted.
A user goal authorizes only matching actions, not unrelated or higher-risk
side effects. Authorization is judged by material effect, not by command
syntax.

### 5. LLM is the semantic layer, not the deterministic gate

Deterministic interception is done by the policy engine; the model adds
semantic judgment. Tool-name exceptions belong in policy config, not in
the prompt. The prompt does not list allow-listed tool names.

### 6. Judge by behavior, not by category label

The same operation can fall into different tiers depending on what it
actually does. Page script execution is classified by payload effect
(DOM inspection → ALLOW; mutations/extractions → DENY-Unless; fetching and
running remote code → DENY-Always). Avoid absolute exclusions ("is not X");
use "judge by what it does".

### 7. Concise, but never at the cost of semantics

- Remove redundant phrasing ("rather than the whole request", "by itself",
  "classify as").
- Merge overlapping entries when their scope is identical; keep them
  separate when a qualifier applies to only one ("outside the project"
  limits persistent changes, not security weakening).
- Inline parenthetical content into the main clause where possible.
- Target ~1300–1450 tokens, accounting for structural heading cost.
- Safety-critical semantics must stay explicit, even when they seem
  implied. Two currently live as literal phrases in the rules — "both
  payload and destination" (Sensitive-Data Egress) and "not unrelated or
  higher-risk side effects" (Trust Boundary). A third, "intent matching
  is not required", used to sit inside the Unknown Commands entry; it was
  relocated to the Intent-Based Routing rule ("no intent → DEFER
  everything outside ALLOW, unless DENY — Always") because the entry-level
  string was misreadable as "unknown commands can be allowed without
  intent". The protective meaning — an unknown command with no matching
  intent DEFERs, never becomes a DENY merely for lacking intent — stays
  explicit at the routing layer. Keep it there; do not re-add the literal
  entry-level string.

### 8. Structure serves navigability

Bold titles and a tiered layout help the model locate the right entry and
reduce misclassification. General rules are split into distinct concepts
(Trust Boundary, Intent-Based Routing, Surface Context, Strict Chain,
Visible Evidence) rather than fused in one paragraph. Section titles must
be unambiguous — a heading that asserts a single fallback breaks when
entries under it have different fallbacks.

### 9. Precise wording, no ambiguity

- "fetching **and** running" (not "or") — fetch alone does not trigger
  DENY-Always.
- "ALLOW with intent, otherwise DEFER" (not "ALLOW/DEFER").
- "is not this category" (not "is EXEMPT").
- Cross-tier annotations use a consistent style across entries.

### 10. Do not over-tune from stale logs

Before adjusting the prompt, confirm which prompt version produced the
logs. Prefer policy config for deterministic-operation false positives.
Only adjust the prompt when there is a systematic semantic bias — and then
make the fallback explicit ("never DENY solely for these"), never add
tool-name exceptions.
