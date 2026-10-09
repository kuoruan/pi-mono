# pi-permission-ai-guard

## 0.14.0

### Minor Changes

- b3e0849: Reviewer classification can now run through Pi's registry, and the classifier lane's config vocabulary is aligned with it.

  **Breaking changes.**

  - **A chat-mode `instructions` string now appends** to the built-in safety rules instead of replacing them. Add `"replace": true` to the `chat` slot (`{ "instructions": { "chat": { "rules": "…", "replace": true } } }`) to keep the old prompt.
  - **`typesafe.timeoutMs` no longer has any effect.** The primary reviewer's timeout is the top-level `timeoutMs` on both lanes — move the value there. `classifier.timeoutMs` is inert in the same way. Both still parse, so an existing config does not fail to load; the loader reports the ignored key, and saving folds the block into `classifier`.
  - **The deprecated top-level `{ "background": … , "questions": … }` `instructions` shape is rejected.** Wrap it in `classifier`: `{ "instructions": { "classifier": { "background": …, "questions": { … } } } }`.

  **Registry classifier backend.** Run the Jev reviewer through Pi's built-in classifier: set `"modelType": "classifier"` on a string provider (`{ "provider": "typesafe", "model": "jev-latest", "modelType": "classifier" }`, pi 0.99+) instead of configuring a direct TypeSafe connection — no API key in config, auth lives in Pi. A registry primary missing from Pi's catalog fails the session; a missing registry fallback is skipped with a warning. A status-bearing `classify` failure — including one that stopped `aborted` — classifies by that status first, so a refusal never fails over, and the endpoint's audit identity carries Pi's provider id rather than the direct backend's `typesafe/` prefix.

  **`classifier` threshold block (renamed from `typesafe`).** The block is now `classifier.intentThreshold` / `riskThreshold` / `confidenceThreshold`, matching the `classifier` lane and `modelType` vocabulary, and it is pure verdict policy: the primary reviewer's timeout is the top-level `timeoutMs` on both lanes, exactly as for chat (a backup still overrides it with its own entry-level `timeoutMs`). Previously `typesafe.timeoutMs` overrode the primary timeout for a direct System One connection; the registry classifier never read it. The old `typesafe` key still parses and its thresholds still fold into `classifier`, but it is deprecated and reports a deprecation notice. It folds **per layer**, before the layers merge, so a project's deprecated block still wins over the global layer's `classifier` block and the two never collide on the schema's both-keys rejection — only a single file writing BOTH keys is rejected. The connection spelling `provider: { type: "typesafe" }` is unchanged.

  **Lane-uniform `instructions`.** A **string** now appends the same content to both lanes: for chat after the built-in safety rules, for the classifier it is the shared background as before. This is the safe direction — an existing string can only make the reviewer stricter, never silently drop the built-in policy. The object form is now per-lane slots:

  ```json
  {
    "instructions": {
      "chat": { "rules": "Deploy through railway up.", "replace": false },
      "classifier": {
        "background": "Monorepo: each package owns its directory.",
        "questions": { "risk": "Touching /migrations is at least medium risk." }
      }
    }
  }
  ```

  - `chat.rules` and `classifier.background` hold each lane's text; `classifier.questions` keeps the per-question additions keyed by question id (`danger_category`, `intent_match`, `risk`).
  - Only the `chat` slot takes `replace: true`, which swaps the built-in safety-rules block for the slot's content instead of appending to it. The classifier lane is append-only: its built-in background, questions, and criteria are the answer contract the verdict thresholds are calibrated against (the background sentence defines the "authorization anchor" the `intent_match` criteria read against), so nothing there is replaceable. The verdict output format is likewise never replaceable.
  - The old top-level `{ background, questions }` shape is gone. Unknown keys are rejected, and so are an empty slot and a slot for a lane the configured pool never contains — including a lane declared only by a fallback that the admission gate later skips.
  - A lane the object leaves out keeps its full built-ins, and the loader reports it as a notice: a partly covered pool (a chat primary with a classifier fallback and only a `classifier` slot) is never silent.

  **Saving never writes an expanded secret.** A leaf whose owning layer spelled it as a `${VAR}` ref is written back as that ref — including when the target layer did not hold that leaf yet (a whole new file, or one new key): the save used to write the expanded value there, which could persist a secret into a layer (often a committed project config) that only ever held the placeholder. The round-trip is still verified against the loaded snapshot, so a variable that disappears between load and save refuses the write instead of persisting a value the config would not load with. Alongside it: config messages never echo the value an unresolvable ref sat in (they name the variable), and `redactSecrets` now also covers `scheme://user:pass@host` URLs.

  **Internals** (a pure move — no behaviour change). The switch/terminal tables both lanes depend on (`switchableStatusReason`, `availabilityReason`, `failoverReason`, `classifyFailure`) now live in one module, `review/failure-taxonomy.ts` — the chat lane reads them through an untyped-string adapter, the classifier lane through a typed-SDK-error one, over one matrix. The chat lane's tolerant JSON verdict parser moved to `engines/chat/verdict-parser.ts`, leaving the lane-neutral `model/model-verdict.ts` with only the shared verdict vocabulary. New backend-equivalence tests drive both backends through the same seam, pinning that matrix and recording the two places where the backends genuinely disagree (pre-existing, fail-safe, previously undocumented): an unclassifiable registry failure is retryable (the facade reconstructs it as a connection error) while a direct one is terminal, and `"timed out"` wording fails over through the facade but not through a direct generic error. Two more consolidations ride along: the pool owns endpoint audit identity now (an endpoint is built with its bare `provider/model` id, and only the pool appends the failover position, where each adapter used to format its own), and the machinery-failure vocabulary moved from `review/machinery-kinds.ts` to `model/machinery-kinds.ts`, so the audit record and the ask projection no longer reach into the review pipeline's directory for a lane-neutral name. The deprecated alias key is one exported constant (`CLASSIFIER_ALIAS_KEY`) rather than the same literal re-spelled in the schema, the per-layer fold, and the save path.

- 7aa1514: The classifier lane now receives the wrapper facts the chat lane already renders: `executed_unit`, `command_context`, and `matched_pattern` join the System One `state`, so a substitution, subshell, or wrapper ask is no longer reviewed on intent alone.

  An ordinary ask's state is unchanged — the three keys appear only on wrapper-shaped asks. The classifier thresholds were calibrated without these facts, so a probability can move on exactly those asks. The chat lane is untouched, and a test-side lane-fact inventory now classifies every ask fact per lane so a future field cannot be silently dropped by one lane.

- 258fce1: The reviewer now reads the spelling a bash rule actually matched on: `matchedSpelling` joins both lanes (`- matched spelling:` in the chat prompt, `matched_spelling` in the classifier state) and the verdict cache key. The gate resolves a typed relative path through its absolute spelling (typed `rm ./x`, matched as `rm /etc/x`), so identical typed text can target two different things: the fact is that evidence, like `executed_unit`. The policy-decided audit record carries it beside `matchedPattern`.

  The peer range accepts pi-permission-system 37 through 40 (`>=27.1.1 <41.0.0`), which previously failed to install because 37 requires Pi 1.0.0 and the old `<37` ceiling refused it. A host below 40 still works: every renderer guards on the fact's presence, and the cache key normalizes an absent spelling to `null`.

- f37e116: The reviewer's configured `reasoning` level now reaches the provider. The chat lane called `ModelRegistry.complete`, whose low-level `stream` only understands `reasoningEffort` — the simple-layer `reasoning` option was silently dropped, so every review ran at the model's `off` level. It now calls `ModelRegistry.streamSimple(...).result()`, which translates `reasoning` through the model's `thinkingLevelMap` (clamping an unsupported level to the nearest supported one).

  **Requires pi >= 0.86** (`registry.streamSimple` was added there); the three `@earendil-works` peer floors move from `>=0.84.0` to `>=0.86.0`. A host below it fails safe at session start instead of deferring every ask as `call-failed`. The registry-classifier backend still needs pi 0.99+ (admission-gated, as before).

  Behavior when `reasoning` is on (the default `off` path is unchanged):

  - On budget-based providers (Anthropic, Bedrock) `maxTokens` is an answer budget: the thinking budget is added on top, bounded by the model's own `maxTokens`. On effort-based providers it stays the cap.
  - An unsupported level is clamped to the nearest supported one instead of being dropped to `off`.
  - A virtual-model reviewer is routed correctly instead of failing the low-level chat-model assert.

### Patch Changes

- 50aaa45: Saving a config can no longer write an expanded secret over an array-held `${VAR}` placeholder.

  - When an env ref inside an array (`fallbacks[].provider.apiKey` and friends) could not be expanded at save time — the variable was rotated away, or simply not exported in the shell doing the save — the write fell back to the in-memory snapshot and put the **expanded secret** into the file, which is usually a committed project config. The remaining disk elements are now searched for the placeholder rather than pairing by position, so neither an element inserted ahead of it nor a reordered array hides it: the value that reaches the file is the ref, never the secret.
  - In that situation the save is refused, with the drift named (`a ref at fallbacks no longer resolves`) rather than the unrelated duplicate-key message it used to report. A leaf with no placeholder to preserve — including an in-memory edit over a ref that still resolves — is written normally.

- 81aab08: A defer on a short approval now asks for the scope instead of only reporting the shortfall.

  - "Ok", "as you recommend", "rename it" names no action of its own — it points at agent text the reviewer never sees. Both lanes read such an anchor as the user's own words authorize, and nothing more.
  - The chat lane's safety rules judge a referential anchor by what the user's words actually name, and its verdict contract requires that defer reason to ask the operator for the scope.
  - The classifier lane's `intent_match` criteria carry the same rule; its synthesized reason for an intent gap is `confirm the scope: is this action covered by your request?`.
  - Synthesized reasons are written for the operator, who is the one reading them: a low-confidence defer asks `is this action safe to run?`, and a danger-hit deny reads `matched a safety rule: system tampering` rather than `matched rule: system_tampering`. The calibrated readings stay available — the audit record keeps every answer in `rawReply`.

- 43964db: Operator-facing notices are no longer truncated, so the reviewer's whole reason reaches the human.

  - The deny/ask notice (`reviewer denied this request (risk …); <reason>`) carries the model's reason whole. A clarification the operator has to answer is never cut mid-sentence.
  - The defer notice (the model's own reason) likewise keeps the full clarification: the dialog alone never shows what the reviewer wants clarified.
  - A failed config load names the complete first issue instead of a 100-character summary — the operator needs the whole message to fix the file.
  - Prompt material and the audit record keep their own size bounds; those are not the user-facing copy.

- 81aab08: The reviewer's rules now lead with the category and keep the specifics as marked examples, so a correct action written another way still has a home.

  - Rules that named one ecosystem's shape no longer do. `ALLOW · Read-Only Operations` names the class (listing, reading, searching, printing); the VCS and publishing rules say shared, protected, or default branch and repository metadata or hooks instead of Git and `main`/`master`; `System Tampering` covers critical system or identity files generally, naming the Windows registry as an example; loopback binding and external code execution no longer assume one flag spelling or `curl | bash`.
  - Two general rules that each ended in "apply the strictest tier" merged into one, and the obfuscated-payload rule folded into `Visible Evidence`. No rule was dropped (general rules 9 → 7) and every DENY/ALLOW category is unchanged.
  - The classifier's criteria keep the same generalization and match the rules' scope: `system_tampering` / `secrets_credentials` widened to identity or configuration stores, permission weakening, private keys, tokens, credential files, and shell history; `destructive_vcs` and `irreversible_destruction` carry the generalized examples. A cross-lane test fails when a category is added to only one lane.
  - The risk rubric stopped naming tiers that lane never defines — `DENY-Unless` there is the `(intent_match, risk)` pair by design, not a category list — and levels 2 and 3 now say what they mean in the request's own vocabulary.
  - The short-approval examples name phrases the reviewer can actually receive: `go ahead` and `do it` are bare continuations the stripper drops before the reviewer sees the anchor, so `ok` takes their place.
  - A meaning-preserving clarity pass: out-of-scope operations name how they happen (`../`, a symlink), `Interactive actions` names them, and the defer reason is written for the operator who reads it. Most of the diff is line breaks — flowmark's semantic mode replaced a hand-maintained column wrap, words and order unchanged.

  Deliberately unchanged: the payload-kind vocabulary (`bash`, `bash_external_directory`, `forwarded`), the surface names, and the loopback addresses are the host's and the protocol's facts. The three JSON sample lines are the parser contract and stay byte-identical.

- 8ed1137: Release hardening across config loading, the review pipeline, the prompt material, and the audit trail. No existing configuration needs to change. Every item moves in the fail-safe direction (degrade, defer, or warn), never a wrong deny.

  **Config**

  - Config diagnostics are written as sentences: no dashes, and no colon where the message is embedded in a notice that already has one (`the snapshot is invalid at $.mode (message)`, `unknown key "surfces"; ignored (check for a typo)`).
  - A top-level key the schema does not know is now reported (`unknown key "surfces"; ignored (check for a typo)`) instead of being dropped in silence. The layer still loads, so a config written for a newer version keeps working; only the typo becomes visible.
  - Saving a config whose deprecated `typesafe` block cannot be removed leaves the file untouched and says so, naming the key: "refusing to write; `typesafe` cannot be removed from this file". The write used to retry forever.
  - Env refs resolve against own keys only, so a `__proto__` key can no longer feed a value into the effective config. A config that contains one still loads.

  **Prompt**

  - The short-approval rule names the agent's own prose rather than "agent text". Tool calls are part of the prompt, so the old wording promised an absence the prompt did not keep.
  - The trust boundary names the human's own words (what they type, and the choices they make), and says a choice authorizes the option it names and nothing wider, since the wording around it may be agent-authored. The old wording named `ask_user_question`, which the model never sees: only the answer text reaches the prompt, and one package's tool name is not the human.
  - The short-approval clause no longer appears twice: the rule stays with the general rules, and the verdict format only says how to phrase the question the operator is asked.
  - Wording for the authorizing person is now consistent: the authority sentences, the anchor definition, and the rendered transcript labels say the human, while transcript structure keeps "user" and the config owner is the operator. The classifier's background sentence called the anchor "the latest user request" although its state carries the trusted intent, which includes a question tool's answer, so it named a channel the answer did not come through.
  - The defer instruction is qualified: the reason is the question the operator is asked _when the defer survives as one_. The strict and lenient modes map a defer to a deny, where nothing is asked.
  - A defer reason names the gap, then the question that would settle it. The operator line used to be a bare question (`is this action safe to run?`) carrying no reason at all, and the chat prompt's example taught the model to parrot the classifier's own constant, so one content-free line reached the operator from both engines. The lanes now share the shape (the gap, then the ask in parentheses), not the words, and the classifier names which reading fell short. The notice is the reason alone: the host supplies the separator before it.

  **Review**

  - Operator notices keep one shape: a structural colon is never ours (the host renders its own level separator) and a dash separator is never ours either, so every line reads as a sentence. The longest lines were trimmed to what the operator acts on: the machinery defer drops "so it is", `/ai-guard` feedback names the layer as `(session)`/`(config)` like the footer and the picker, and the breaker, save-config, report, and registration lines lost their padding.

  - A chat reply stating two different verdicts now defers to the human instead of taking the first. A self-contradictory reply must not decide.
  - A deny without a reason notifies with the generic reason. It previously fell through to the defer branch and rendered nothing at all.
  - Model-generated annotations are never rendered into the prompt and never reach the verdict; keeping them out of the verdict cache key is now correct by design rather than a coincidence.
  - A question tool's result reaches the reviewer as the tool returned it: its structured payload as JSON when it carries one, its own text otherwise. Only two names are trusted: `ask_user_question` and `ask_user`, the ones whose names say _user_. Near-names such as `ask`, `ask_question`, or a model-delegation tool (`pi-ask-codex`) stay untrusted, because trusting them would let the agent's prose become the authorization anchor.
  - The structured payload keeps the question text next to each answer, so the reviewer can tell what an answer authorizes. Nothing is re-rendered or summarized: the packages disagree on the shape, and a dropped field is authorization the reviewer cannot see.
  - A cancelled questionnaire travels as its own payload (`cancelled: true`), so a refused or failed dialog is visible as such instead of arriving as the sentence the tool writes about it.
  - The denied panel keeps the 50 most recent denials instead of growing for the life of the session.
  - A reply whose first verdict object is unbalanced now defers instead of letting a later object decide the ask. The parser had only guarded the balanced case, so a malformed open brace could hand a later allow example the verdict.
  - A provider refusal that arrives with "aborted" in its text stays terminal and is recorded as `call-failed`, not `timeout`. The defer kind is what the operator reads, and the classifier backend's error reconstruction no longer rebuilds such a refusal as a switchable timeout (or a switchable connection failure).

  **Audit**

  - The recorded `rawReply` is bounded (2000 characters, truncated in the middle), so a pathological reply cannot bloat the log.
  - A policy pattern is redacted at the record factory, where every producer passes.
  - A crashed review writes an `internal-error` record, so the log shows the failure instead of stopping at the pre-call gate.
  - The log tail reader honors short reads: a window that only partially fills is no longer parsed as a truncated line.
  - Suggested rules ignore patterns that were redacted on the way in.
  - The crash record is written independently of the debug line, so a throwing debug sink no longer costs the audit trail the record that says the review crashed.

- 876820e: The classifier lane's published walk budget is now real, and a failed attempt is never missing from the audit log.

  - A classifier walk can no longer run past `walkBudgetMs`: the call carries the walk's remaining budget as a signal, passed into the request (pi-ai ≥0.99 forwards it) and raced locally, so a version that ignores the option still cannot outlive the budget. The direct backend aborts outright. A single-endpoint walk keeps its transport retries, which is what made this matter: each SDK retry used to get a fresh per-attempt timeout.
  - URL userinfo redaction now swallows a password that itself contains `@` (`https://user:p@ssw0rd@host`); matching only to the first `@` left the rest of the password on the line.
  - A failover hop is audited only once the endpoint it leads to is actually contacted, so the review log no longer records a hop that the remaining budget then cancels.
  - A failed classifier attempt is recorded where it is observed, so a retryable failure that a backup takes over still appears as `model_call_error`. Previously only the exhaustion path recorded it, and the chat lane already recorded its own — one walk now reads the same in both lanes.
  - Saving a config no longer expands a prototype key: `${constructor}` / `${__proto__}` read as unset (fallback or skip) instead of expanding to a JavaScript prototype member that passed the value schema.
  - The secret redaction pattern covers the scoped OpenAI key shapes (`sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`), which the older alphanumeric-only rule matched only up to the scope hyphen.
  - A notice issued before the first session is no longer dropped silently: it warns, the same way a disposed UI context already did.
  - A session-scoped setting change persists before the in-memory override is written, so a failed write leaves memory and the session file in agreement.

## 0.13.0

### Minor Changes

- e24ae10: Support `${VAR}` / `${VAR:-default}` / `$$` env interpolation in config string leaves (including inside `fallbacks[]`), and keep `${...}` placeholders intact on save: persisting restores on-disk placeholder text instead of writing expanded secrets back, across append/prepend/remove/reorder. A placeholder whose variable vanished since load also keeps its on-disk text (the integrity gate refuses the write rather than leaking the secret).

### Patch Changes

- c884510: Name the failing config fields in the fail-safe start notice instead of a bare "fix the config", and report an ignored project config in untrusted projects rather than claiming no config file exists.

## 0.12.0

### Minor Changes

- 523b6cd: Opt-in approval notices (`notifyApprovals`) now carry a duration tail: fresh reviews report their total review cost (`reviewer approved this request (1.2s)`), cache replays say `(cached)`, and mode-mapped allows name the mode (`mode (permissive) auto-approved this request (1.2s)`).
- 14f8657: Label Jev risk-lane denies by the fixed quartile bands of the 0–4 rubric (low below 0.25, medium below 0.5, high below 0.75, critical at or above), independent of `riskThreshold` — `riskThreshold` alone decides the deny. With the default 0.5, every risk-lane deny reads high or critical and blocks in every mode including permissive, catching danger-missed destruction.

  Derive the defer lean from the danger direction (risk over the line leans deny, a pure intent gap with trusted readings leans allow, otherwise neutral) so the mode ladder treats benign and danger-leaning doubts like the LLM lane. Treat responses with missing readings as malformed (machinery defer, never allow) instead of zero-projecting them.

- 16b5956: Upgrade @gotgenes/pi-permission-system to ^35.0.1 (redirect/heredoc gating fixes).
- 1d559c1: Upgrade @gotgenes/pi-permission-system to ^36.0.0 (sed/awk/find read-claim fixes).

### Patch Changes

- ad391c9: Move the call-failure audit sink beside the audit cluster with no behaviour change: both engines import it from one place instead of the Jev lane depending on the LLM call module.
- 6b0ca82: Rewrite the `irreversible_destruction` criteria (Jev) and prompt section (LLM) as a positive definition: only data with no version-control or session recovery counts. Recoverable in-project deletions and unstage-only resets fall through to Deletions (DENY — Unless) instead of hard-denying.
- ec81634: Unify operator notice voice with no behaviour change: deny reasons start lowercase, and the crash defer notice says "deferring to you" like the other defer notices.

## 0.11.0

### Minor Changes

- 86024d0: Let `fallbacks` mix chat-model and System One reviewers in any order behind one ordered failover loop. Valid decisions stay final, auth failures never switch vendors, and backup verdicts are never cached.
- 57219ce: Show an optional notice when AI Guard approves a permission request, so you can tell it approved the request without exposing the command. Enable it with `notifyApprovals: true` and `notifyLevel: "info"`.

### Patch Changes

- cba5754: Consolidate reviewer internals with no behaviour change: one availability classifier beside its type, instructions shaping in one module, and no redundant `detail` on model-unresolved debug records.

## 0.10.1

### Patch Changes

- 588da56: Intent check now carries yes/no criteria: matched workspace actions score +0.15-0.25 higher while mismatched actions stay flat, cutting model-defer on ordinary in-scope work. Verified by live A/B (6 matched + 6 mismatched fixtures x3, zero movement on mismatches).
- 81246f1: Bare user continuations ("go on") no longer consume transcript quota, and adjacent exact repeats collapse to one: the stripper drops both before the window fills, so neither evicts the real task sentence the intent check authorizes against. Closed word list with exact matching across English, Simplified and Traditional Chinese; narrowing signals ("stop", "wait", "no") are excluded and keep the anchor slot.
- f0002ca: Provider error text is truncated to 300 chars before it reaches the log: error pages (e.g. Cloudflare HTML from a WAF block) no longer land unbounded in debug records, where the transcript would feed them back into the next request's state and get the call blocked again. Applies to thrown call failures on both engines and to `reply.errorMessage` on the empty-reply path. The danger Choice criteria were also slimmed to descriptive wording after literal attack spellings accumulated enough WAF score to 403 the whole call.

## 0.10.0

### Minor Changes

- bb014d5: Add a Jev reviewer path: set `provider` to `{ type: "typesafe" }` to review through TypeSafe's Jev (System One) instead of an LLM. Three built-in questions (`danger_category`, `intent_match`, `risk`) synthesize the verdict — allow needs matching intent plus risk below the deny line. Thresholds live in a new `typesafe` section (`intentThreshold`, `riskThreshold`, `confidenceThreshold`, optional per-attempt `timeoutMs`); `reasoning`/`maxTokens` are ignored in Jev mode, `instructions` overlays onto the built-in questions instead of replacing them, and ask fields are redacted before they leave, matching the LLM path.

### Patch Changes

- 913a6f1: Emit an `ai_guard.coverage` debug breadcrumb when an ask falls outside this link's surfaces, so a thought-covered-but-never-reviewed misconfig is discoverable with diagnostics on. The ask still defers.
- ef8caa6: Collect the pipeline gates' release ritual into a `disposition` module: `releaseMachineryGate` owns the four reviewer-failure gates' disposal, the new `releaseVerdictGate` owns the cache-hit and fresh-model gates' mapping side effects. Zero behavior change.
- 360b4e2: Support `@gotgenes/pi-permission-system` 33.x (peer `>=27.1.1 <34.0.0`): the 33.x public surface is identical, so no code change was needed.
- 2c9005a: Route model calls through `ModelRegistry.complete` (upstream tightened the provider input; requires pi >= 0.84). Key the verdict cache context on trusted intent only, so agent retries hit between user turns.
- 7532394: Count the reviewer's own refusals as terminal for `/ai-guard report` candidate groups — a model deny the mode escalated from a defer (`emittedVerdict`) now disqualifies the group, and a valid-JSON non-object log line (`null`) is skipped like any corrupt line instead of crashing the panel.
- 347a763: Harden `shortHash` (verdict-cache keys, log correlation) from dual-32-bit Math.imul to 16-char SHA-256, so an agent-influenced command cannot preimage onto an allowed command's key and inherit its verdict.
- 7532394: Stop three ways the guard could fall silent or mislead: a failed registration now retries on the next session instead of latching for the process lifetime; an unexpected pipeline crash still defers but says so on the notify line; and a session whose config failed to load clears the footer instead of leaving the previous session's mode on display.
- d6abba7: Recognize `verdict=` alongside `verdict:` when scanning malformed model replies, so a pseudo-JSON verdict like `{verdict="deny"}` stops the scan instead of being skipped as brace noise.

## 0.9.1

### Patch Changes

- aa9457f: Track `@gotgenes/pi-permission-system` 32 (peer range `>=27.1.1 <33.0.0`). The v32 breaking change — a UI-bearing subagent relays its asks to its declared parent instead of adjudicating locally — moves this extension's link up one hop rather than removing it: a relaying node runs no chain, and the serving parent adjudicates the forwarded ask through its own chain, this link included. The API surface this extension consumes is unchanged across v31 and v32.

## 0.9.0

### Minor Changes

- 1dc9c33: Two new `/ai-guard` subcommands. `report` aggregates the review log's tail and suggests copy-paste permission-rule fragments for asks that reached the model 3+ times, all in one trusted-intent context, with no terminal deny anywhere (a model deny itself disqualifies the group — the reviewer refused, held in the signal rather than trusted from upstream's terminal records) — evidence for the operator, never an applied rule. `denied` lists this session's model-gate denies (most recent first) and echoes the picked record's reason (capped at the notify reason ceiling like every other model-reason line). Both panels are menu rows in `/ai-guard` beside the save and breaker actions — the menu lists every verb. A picked record opens a floating detail dialog (pi-tui overlay — the same SelectList-era components the host's own pickers use, new `@earendil-works/pi-tui` peer): the command and the model's reason are shown whole, replacing the old single-line notify echo and its 200-character ceiling (the dialog is a reading surface; the list line remains the scan index). The model-gate decision record now also carries the `contextHash` fingerprint (same value as the verdict-cache key's context hash), so audit readers can tell same-context repetitions from cross-context ones; deny history is session-memory, targets ride the record's redacted form.

### Patch Changes

- 9c1c951: Two internal-hardening changes, one release line each.

  **The `/ai-guard` command rides one entry table.** The command's verbs (settings, save-config, breaker, report, denied) share a single table — completion, the settings menu, and dispatch all traverse it, so adding a verb is one entry instead of four hand-built touch points, and the read-only panels' collaborators no longer cross the settings seam. Two argument-error lines got honest along the way: an unknown first token now lists every valid command (a typo'd verb previously read as a misleading unknown-setting error), and a bare or wrong `breaker` argument says `breaker takes one action — reset`. A setting's verb is its config field's kebab form — `/ai-guard notify-level warning` (`notifyLevel` the field, `notify-level` the verb: the command shape used across pi's built-ins and examples, derived rather than declared; menus and notices re-segment it into a phrase, `notify level — info (config)`), and the two save verbs collapse into one `/ai-guard save-config <global|project>` with its direction as the argument — the same verb-plus-fixed-argument shape as `breaker reset`; a bare save-config (or the menu's save row) opens a target picker, the same two-step shape as a setting's value picker, and a wrong target names what it takes. Read-only surfaces (menu rows, picker titles, change notices) render the verb as a phrase (`notify level — info (config)`, matching `save config`), while typed surfaces (completion, dispatch, error listings) keep the kebab word.

  **`scripts/log-stats.ts` reads the log through the decision-log-reader module** — one owner for the review log's format (record shape, tolerant parse, canonical path), consistent with the report command: the script now sees the last 5000 lines instead of the whole file, and a log-format change breaks it at compile time instead of silently going stale (the old private copy had already missed `contextHash`). The tail adapter it now shares also gained a fix: a trailing newline no longer evicts the last real line from the window. Alongside, `resolveMapping` now owns the whole emission doctrine — the defer-side operator notices (the reviewer-asks mirror, the machinery cause) and the deny instruction's source discrimination moved in from the pipeline's inline branches, so the two verdict gates (cache-hit and fresh model) perform one uniform decision; the pipeline's local payload builders collapsed into the shared test fixtures; and the settings panels' four label-reverse-mapping pickers collapsed into one pick-by-item helper (no behavior change in any of these).

- 44c91e6: The review prompt's trusted-intent section is now layered: the latest user message renders under its own "authorization anchor" heading (the request the agent is currently acting on), earlier messages under a separate context heading, and the Intent-Based Routing rule states the anchor doctrine. An experimental navigation change (principle 8), to be validated against live defer/lean data — not a fallback adjustment. Also fixes the `StrippedTranscript.trustedIntent` docblock, which misdescribed the array as "most recent first" (it is chronological).
- 95c675e: Terminal deny verdicts carry a prepended agent-facing behavioral instruction (instruction first, teaching reason after — the host's agent-side render already fronts its own attribution sentence, so the pair reads as "what to do — why"; the instruction carries no trailing period because that render appends its own): content denies (the review judged the request) tell the agent not to rephrase, retry, or work around it and to have the user re-request explicitly; machinery denies (the review failed) tell the agent the reviewer itself failed and a later retry is legitimate. The instruction rides only the returned verdict's reason — the audit record's `emittedReason` and the operator notify lines keep the un-instructed teaching reason. First live feedback: the verdict section's reason contract now also forbids asserting what the reviewer cannot see (the user's intent, the conversation, invented details) — real denies had claimed "without explicit user intent" for an approval that existed in the conversation the reviewer never sees, and had invented a lock-file detail.
- d3180f8: Harden the hot path and simplify the internals. The transcript stripper now checks the tool-call quota BEFORE extracting (older assistant messages were fully stringified and redacted, then discarded — O(session × argument size) per ask, 10–50ms in long coding sessions). Redaction has a single boundary: the stripper (per its `StrippedTranscript` contract) sanitizes transcript entries once, the prompt renders them verbatim, and a composed end-to-end test pins the chain — the previous prompt-side re-redaction was the same pure function run twice (shared failure modes, no independence), and its tests had drifted onto inputs the stripper cannot produce. A defer's raw reply is redacted once in the pipeline and feeds both the debug event and the decision record. The system prompt is computed once per pipeline (a session invariant), glob patterns compile once per process, and notify-level ranking no longer allocates per call. Simplifications: `annotateAndEscalate` takes one optional `ModelDeferInfo` instead of three trailing scalars, `persistConfigLayer` splits into its two mutually exclusive results (create / edit), `CircuitBreakerConfig` is the schema's inferred shape instead of a hand-copied one, and `displayPhrase` delegates to `verbWord` so the two faces cannot drift.
- d7e2635: Track `@gotgenes/pi-permission-system` 30 with a quadruple-version peer range (`^27.1.1 || ^28.0.0 || ^29.0.0 || ^30.0.0`).

  30.0.0's breaking change replaces `ForwardedSessionApproval`'s `surface` + `patterns` with per-pattern `grants` — a field this extension never reads (its links rule on the request, not on the whole-session grant scope), so the API surface we consume is identical across all four majors and the dev dependency runs the full suite against 30.0.0.

- 5ebd83d: Track `@gotgenes/pi-permission-system` 31 — the peer range becomes `>=27.1.1 <32.0.0` (the five-major OR chain collapsed into one bounded range: semantically identical over every published version — 27.0.x stays excluded by the floor, 32+ by the ceiling — and a future major needs one token instead of a new disjunct).

  31.0.0's breaking changes are two bash-gate path-gating fixes (paths named as `for`/`select` loop operands and `case` subjects are now gated). The 31.1.x patch line (31.0.1 → 31.1.3) keeps the public API surface byte-identical — diffed shipped declarations show only a docblock relocation — so no code changes: 31.0.1 consults both path directions for an unresolved redirect, 31.0.2 prompts on a bash command whose parse could not be resolved (fail-closed: those asks now legitimately reach the chain and fall back to the review's safe defers), 31.1.0 records effective tool-surface changes in the debug log, and 31.1.3 states each session's own tool list — none of which this extension consumes. 30.1 added `PermissionsService.isToolFullyDenied` (cross-extension tool pre-filtering) and 30.2 added a both-directions session grant at the ask prompt — neither is consumed here yet. The dev dependency runs the full suite against 31.1.3.

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
