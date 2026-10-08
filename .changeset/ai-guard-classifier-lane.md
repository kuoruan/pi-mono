---
"pi-permission-ai-guard": minor
---

Reviewer classification can now run through Pi's registry, and the classifier lane's config vocabulary is aligned with it.

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
