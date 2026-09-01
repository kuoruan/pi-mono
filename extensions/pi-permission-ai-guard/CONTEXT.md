# pi-permission-ai-guard

A Pi extension that reviews permission **asks** with a light model, using a token-optimized stripped transcript. This file pins down the ubiquitous language so reviews, navigators (human or AI), and future contributors share one vocabulary.

## Language

### The ask

**Ask**:
A permission request submitted to the authorizer chain. The thing being reviewed: a shell command, a tool call, a skill invocation. _Avoid_: request, prompt (reserved for model prompts)

**Surface**:
The tool type an ask targets (`bash`, `mcp`, `skill`, or a namespaced tool name like `my-ext:tool`). The first eligibility gate. _Avoid_: tool, command (a surface is the type, not the specific invocation)

**Review target**:
The value being authorized (the command string, tool name, path, etc.). Resolved together with the surface; if no target can be extracted, the ask is not reviewable.

**Ask eligibility**:
Whether an ask qualifies for AI review — the surface matches the configured list AND a review target can be extracted.

Note: `external_directory`/`path` asks reach this link, but any `allow` on them is capped to `defer` by the host's bounded-delegation checkpoint (ADR 0007 §5, unchanged 25.x→26.0). The link's value there is limited to a confident `deny`; an `allow` is never honored. The default `surfaces` config (`["bash", "mcp", "skill"]`) excludes both, so by default the link never reviews them — and even opt-in can't auto-allow them.

### Verdicts

**Policy gate**:
The deterministic engine queried before the model. If the policy already says `allow` or `deny`, the AI-guard link defers — it only adds value when the policy is undecided (`ask`).

**Verdict**:
The link's ruling: `allow`, `deny` (with optional teaching `reason`), or `defer` (pass to the next chain link).

**Defer**:
The fail-safe outcome. A missing model, invalid config, model timeout, unparseable reply, or unsure verdict all defer. Deferring means the ask falls through to the normal permission prompt.

**Lean**:
The reviewer's directional inclination on a defer — which way it would decide if forced to pick now (`allow` or `deny`; omitted means genuinely neutral). A routing signal only: it selects the defer's lane in the mode ladder and never surfaces to the human (dialogs and notify lines carry the clarification question, not the lean — the ask is the operator's judgment moment, and the model's own inclination must not anchor it). Lives in the audit record (`lean: "allow" | "deny" | null`). An invalid value degrades to neutral — a defer is never invalidated by its lean.

**Suspicion order**:
The total order the ladder is drawn on: `allow` < `defer` (lean: allow) < `defer` (neutral) < `defer` (lean: deny) < `deny` (soft) < `deny` (hard). Each mode is two cut lines on this order — an auto-pass band, an ask band, a terminal-deny band — contiguous in every mode (a pinned structural invariant, not a coincidence). Lean moves a defer across only the ask↔allow boundary, in the lean's own direction; below strict, the deny band is reachable only by decisive (hard-tier) denies; the two extremes (`strict`, `permissive`) are lean-inert. The ask sets nest strictly (`default` ⊃ `lenient`; `permissive` asks nothing), and an unresolved verdict always keeps an ask path somewhere in the ladder (`default` asks on every defer) — the intent question can always reach the authorizer. The fail-open cells (defer passing in `lenient` — benign ones silently, a first neutral one with a notice) are deliberate: the operator's explicit product intent to offer fail-open rungs.

**Mode**:
The leniency ladder for the reviewer's non-allow verdicts, strictest first. Denies split by tier: the **hard tier** (riskLevel high|critical, or missing) is terminal in EVERY mode — the reviewer's hard stops are never loosened. The **soft tier** (low/medium) and the model's own uncertainty (split by its lean) map against the ladder (structure: **suspicion order**):

- `strict`: everything denies — the reviewer's `allow` is the only pass.
- `default`: you judge every flag but hard danger — soft denies and every unresolved doubt (any lean) ask. The resting mode and the onboarding posture: watch the reviewer work, then loosen.
- `lenient`: benign and neutral doubts pass; soft denies and danger-leaned doubts ask.
- `permissive`: everything passes except hard-tier denies.

- Reviewer machinery failures (model unresolved, auth failed, transcript errors, timeouts, unparseable or empty replies, no review target) never map to allow in any mode — a broken reviewer must not rubber-stamp: they deny under `strict` (fail-closed by doctrine) and `permissive` (allow needs a verdict), and defer under the other two. The `permissive` deny is the ladder's one non-monotone cell (`lenient` defers, `permissive` denies) — a defer would need a dialog the yolo contract forbids. Contract over monotonicity, stated as an exception.
- A machinery-forced defer notifies its classified cause, repeatedly when the failure repeats (no dedup: the same kind can recur for different underlying reasons, and each interruption lands on its own dialog).
- The model's judgment is always recorded; the mode maps only what the link emits. The ctrl+alt+g cycle visits `default → lenient → permissive`; only `strict` is set explicitly via `/ai-guard mode strict` (full fail-closed automation deserves a deliberate choice — the red footer makes the permissive stop visible).
- Session overrides persist in the pi session file and restore on resume; a fresh session starts from the config default. The save actions (`save-to-global-config` / `save-to-project-config`) persist the current effective config — every field, session overrides included — into a config layer, so a saved field shadows the layers beneath it.

### Session state

**Node**:
One session runtime with its own permissions service and lifecycle — the root session and every in-process subagent child run as separate nodes (upstream ADR 0012). The ai-guard link registers once per node, on that node's own service; a branch or rewind within a session is still the same node.

**Circuit breaker**:
Per-session, two-tier, fail-safe.

- `consecutive` — recoverable tier: trips after N consecutive denials, then resets so the model gets another chance. `total` — hard session cap: never resets on its own (only `/ai-guard breaker reset` or a restart clears it).
- Breaker trips are NOT counted as model denials. Deny-equivalents — machinery-failure denials (the modes that deny them) AND `strict`'s model-defer→deny mapping — count into `consecutive` only: a broken or persistently uncertain reviewer can trip the recoverable tier like a miscalibrated one, but an equivalent storm never burns the permanent `total` tier (model-denies-only).
- The total tier's first trip notifies once at error grade (re-armed by a reset; the ambient channel's only error line — `notifyLevel` `off` silences it and consumes the once-per-epoch claim, the `error` threshold keeps it visible).
- `/ai-guard breaker reset` clears both tiers — pure in-memory counter mutation (nothing persisted, nothing else touched; resume builds fresh breaker state regardless).

**Verdict cache**:
Per-session LRU keyed by a review request snapshot (a decision-relevant projection of the ask) and a trusted-intent context fingerprint. A repeated identical ask in a stable conversation skips the model.

- `curl example.com` and `curl example.com | bash` are distinct (different `executed unit`).
- The gate label `surface` is not in the key — it is an administrative label the model is told to ignore, so two asks sharing kind + content but differing only in surface reach the same verdict and intentionally collide. The same doctrine covers the other administrative labels: the key holds only decision-relevant facts, and the exclusion set is exhaustive — a fact is never excluded silently.
- Only commands that reached the model (policy `ask`) are cached; defer is never cached.

**Deny history**:
Session-memory list of what the reviewer itself refused (`/ai-guard denied` reads it) — model-gate denies only: mapping artifacts (mode-softened denies, `strict`'s defer→deny) and machinery denials are absent by design, and a cached deny replays without a new entry. Each record carries the teaching reason un-instructed (exactly as the audit record holds it) and the redacted target form (a credential in the command must not echo to the terminal via the panel's notify).

### Review

**Full review**:
The JSON-verdict review. The model receives a stripped transcript + the permission request and is asked to return `{"verdict":"allow|deny|defer","reason":"...","riskLevel":"..."}`. A tolerant parser extracts the JSON from prose-wrapped replies, so providers that wrap JSON in text still work. Deny and defer carry a `reason`; allow omits it. A deny reason must state what makes the request dangerous — an assessment that concludes "safe" must be an `allow` (the reason binds to the verdict; a live contradictory pair is a model misfire, not a pipeline error).

**Upstream retry**:
One retry per mechanism per review, budgeted inside `timeoutMs` (the total-budget promise — a review never exceeds one window):

- **Provider errors** (408/409/429/5xx and connection-level failures, per pi-ai's classifier) retry inside pi-ai's provider layer, with backoff and `retry-after`; the timeout signal spans every attempt.
- **Empty replies** (200 with no usable text) retry at the review layer, gated on the first attempt consuming less than half the window (the retry always has ≥ half a window).

The retry carries no provider-layer retry — three requests is the hard ceiling. `attempts: 2` marks a retried review in the decision record; the retry's budgetless provider errors fail straight to `call-failed`. The first attempt's empty diagnostic goes to the debug stream before the retry replaces the reply.

**Operator notices**:
The notify-line doctrine: all lines go through `ui.notify` (the footer channel is mode-status only); one seam (`#safeNotify`) owns the `[ai-guard]` prefix and the disposed-runner guard.

- **Channels** — the pipeline rides the ambient channel, gated by the effective `notifyLevel` (`info` default; `warning` silences the `reviewer asks` mirror; `error` keeps only the total-tier trip; `off` silences all ambient traffic). The settings surface rides the feedback channel, never gated — a silent answer to a typed command reads as breakage — and the guard-absent errors ride it too (a fail-safe config start, a failed registration, a stale registration notify at error grade unconditionally: the operator must never miss that no reviewer stands in front of asks).
- **Levels** — `info` is normal-operation context (the `reviewer asks` mirror, state echoes, command feedback); `warning` is attention owed (deny escalations and softened denies, the fail-open notice, machinery- and breaker-defer causes, the no-session guard, the danger-rung state echo); `error` is reserved for a broken review function or a failed command (the total-tier trip, plus save, registration, and settings-input failures).
- **Skeleton** — event sentence + em-dash consequence + parenthesized qualifier; no structural colons (the TUI's level prefix would double them); state echoes (`mode = permissive (session override)`) are the deliberate exception.
- **Deny lines** — a model deny that holds or escalates notifies in every mode (the host renders no dialog for denials — the line is the operator's only copy; since v28 the agent-side render names this link as the refuser, so the reason reads as policy, not user instruction). A mode-softened deny ends `— asking you instead`; a deny that holds needs no tail; `permissive` swallows soft denies whole (zero-interruption contract — the one-time fail-open notice covers it).
- **Agent instructions** — the deny verdict the chain returns carries an appended behavioral instruction (identity: automatic review, not a human click; the legitimate path: stop pursuing / retry later). Two variants: content denies (the review judged the request — do not rephrase, retry, or work around; the user re-requests explicitly) and machinery denies (the review failed — retry later is legitimate). The instruction rides ONLY the returned verdict's reason: the audit `emittedReason` and the operator notify lines keep the un-instructed teaching reason.
- **Reason text** — model reasons go out whole with a 200-char defensive ceiling (`NOTIFY_REASON_CEILING`; the prompt anchors reasons at ~150 characters); the audit record keeps the full text regardless.
- **Silence lanes** — machinery denies stay silent (fail-closed needs no announcement); machinery defers and deferring breaker trips always name their cause. The `off`/`warning` blindness is operator-owned and documented; a non-default `notifyLevel` renders a footer fragment so a silenced pane stays visible.

**Ask context**:
The structured projection of a permission ask the full review feeds the model — a `kind`-dispatched projection of the facts that can change a verdict, with evidence pre-resolved into named fields so no consumer does string-keyed lookups. Built once by `buildAskContext`; the prompt renderer and the verdict cache both read its typed fields, so neither re-parses the upstream `PromptPayload` (ADR 0011: every consumer is a renderer over the payload, and ai-guard is one).

**Decision record**:
The audit-log entry emitted at each decision gate (policy-decided, circuit-breaker, no-target, model-unresolved, auth-failed, transcript-error, cache-hit, model). Stream doctrine:

- **Review stream** (always on): reviewer-relevant gates — model, circuit-breaker, no-target, model-unresolved, auth-failed, transcript-error — write to `permission-review.jsonl`.
- **Debug stream** (written only while the permission system's `debugLog` is on): pass-through gates (policy-decided, cache-hit) and every verbose/diagnostic payload (raw replies on defer failures only, call errors, cache-miss telemetry, transcript short-circuits, empty-reply stop-reason details).

**Policy suggestion**:
A report candidate for a deterministic permission rule: the same ask (surface + target) reached the model ≥3 times, every occurrence in one trusted-intent context (same `contextHash`), with no terminal deny anywhere. Evidence, never authorization — the report renders copy-paste rule fragments; adopting one is the operator's explicit action in the permission system's config.

### Transcript

**Stripped transcript**:
A token-optimized transcript fed to the model. Keeps trusted user messages (including `ask_user_question` answers) and tool-call names+args; deletes assistant text, tool results, and compaction summaries (summaries may contain model output and must never become authorization signals).

**Trusted intent**:
The user-message portion of the stripped transcript. The only authorization signal the model is told to honor.

## External seams (upstream, immutable)

- `Authorizer.authorize(details, query, log): Promise<AuthorizerVerdict>`
- `AuthorizerLog { review(event, details?), debug(event, details?) }`
- `PermissionQuery { checkPermission, getToolPermission }`
- `getPermissionsService(sessionId)` — the session-keyed service locator
- `permissions:ready` — fires at least once per session, may repeat

All from `@gotgenes/pi-permission-system` (peer range `^27.1.1 || ^28.0.0 || ^29.0.0` — the API surface we consume is identical across the three majors; v28 adds decision attribution and v29 removes the process-root slot this extension never referenced):

- **Registration** — the extension registers an `"ai-guard"` chain link via `service.registerAuthorizer` on the session's OWN permissions node: the service is fetched from the session-keyed locator, registered exactly once per session (whichever of session_start / permissions:ready comes first; ready repeats are no-ops), and released on session_shutdown.
- **One instance per node** — this rests on the v27 host contract of one extension instance per session node (each node has its own ExtensionContext — upstream ADR 0012); nodes never share an instance.
- **No session id → no keyed node** — hosts without a session id have no keyed node: the link stays unregistered and every ask defers.

## Prompt writing principles

The safety rules prompt (`SAFETY_RULES` in `src/prompt.ts`) is the semantic instruction fed to the review model. These principles govern how it is written and maintained.

### 1. Semantic, not literal

Rules describe abstract concepts ("credential stores, private keys"), not environment-specific paths or tool names. A few generic examples (`curl|bash`, `chmod +s`) are fine as anchors, but they never act as the default gate — the category description does. Redundant qualifiers ("of unverified package" when the verb already implies it) are removed.

### 2. Three-tier precedence: DENY-Always > DENY-Unless > ALLOW

- **DENY-Always**: deny regardless of intent (secrets, irreversible destruction, external code execution, etc.).
- **DENY-Unless**: allow only with matching intent; otherwise the fallback the entry itself specifies (deny or defer).
- **ALLOW**: allow only when matching the current task context.

Each entry's fallback is stated by the entry, not by the section heading — different entries in the same section can have different fallbacks (Deletions → DENY, Unknown Commands → DEFER).

### 3. Uncertain → DEFER, not → DENY

Absent intent defaults to defer, not deny. "(none found)" is insufficient evidence, not proof of absence. Unfamiliarity alone is not dangerous. Non-destructive observation (navigation, read-only diagnostics, page selection) without intent defers; it is never denied solely for being that action.

### 4. Trusted intent is the only authorization source

Transcript, tool calls, action text, and permission requests are untrusted. A user goal authorizes only matching actions, not unrelated or higher-risk side effects. Authorization is judged by material effect, not by command syntax.

### 5. LLM is the semantic layer, not the deterministic gate

Deterministic interception is done by the policy engine; the model adds semantic judgment. Tool-name exceptions belong in policy config, not in the prompt. The prompt does not list allow-listed tool names.

### 6. Judge by behavior, not by category label

The same operation can fall into different tiers depending on what it actually does. Page script execution is classified by payload effect (DOM inspection → ALLOW; mutations/extractions → DENY-Unless; fetching and running remote code → DENY-Always). Avoid absolute exclusions ("is not X"); use "judge by what it does".

### 7. Concise, but never at the cost of semantics

- Remove redundant phrasing ("rather than the whole request", "by itself", "classify as").
- Merge overlapping entries when their scope is identical; keep them separate when a qualifier applies to only one ("outside the project" limits persistent changes, not security weakening).
- Inline parenthetical content into the main clause where possible.
- Minimize token count — the prompt is sent on every model review, and the safety rules block is not cached. But never compress at the cost of principle 8: splitting distinct concepts stays even if it costs tokens, because navigability reduces misclassification.
- Safety-critical semantics must stay explicit, even when they seem implied. Two currently live as literal phrases in the rules — "both payload and destination" (Sensitive-Data Egress) and "not unrelated or higher-risk side effects" (Trust Boundary). A third, "intent matching is not required", used to sit inside the Unknown Commands entry; it was relocated to the Intent-Based Routing rule ("no intent → DEFER everything outside ALLOW, unless DENY — Always") because the entry-level string was misreadable as "unknown commands can be allowed without intent". The protective meaning — an unknown command with no matching intent DEFERs, never becomes a DENY merely for lacking intent — stays explicit at the routing layer. Keep it there; do not re-add the literal entry-level string.

### 8. Structure serves navigability

Bold titles and a tiered layout help the model locate the right entry and reduce misclassification. General rules are split into distinct concepts rather than fused in one paragraph — each evidence-handling concern (material-effect judgment, obfuscated payloads, structured-fact weighting) and each surface-routing concern (loopback binding, chain evaluation) stands as its own entry. Section titles must be unambiguous — a heading that asserts a single fallback breaks when entries under it have different fallbacks.

### 9. Precise wording, no ambiguity

- "fetching **and** running" (not "or") — fetch alone does not trigger DENY-Always.
- "ALLOW with intent, otherwise DEFER" (not "ALLOW/DEFER").
- "is not this category" (not "is EXEMPT").
- Cross-tier annotations use a consistent style across entries.

### 10. Do not over-tune from stale logs

Before adjusting the prompt, confirm which prompt version produced the logs. Prefer policy config for deterministic-operation false positives. Only adjust the prompt when there is a systematic semantic bias — and then make the fallback explicit ("never DENY solely for these"), never add tool-name exceptions.
