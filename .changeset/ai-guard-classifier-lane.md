---
"pi-permission-ai-guard": minor
---

Reviewer classification can now run through Pi's registry, and the classifier lane's config vocabulary is aligned with it.

**Breaking changes.**

- **A chat-mode `instructions` string now appends** to the built-in safety rules instead of replacing them. Add `"replace": true` to the `chat` slot (`{ "instructions": { "chat": { "rules": "…", "replace": true } } }`) to keep the old prompt.
- **`typesafe.timeoutMs` no longer has any effect.** The primary reviewer's timeout is the top-level `timeoutMs` on both lanes — move the value there. The loader reports the ignored key at startup, and saving folds the block into `classifier` (dropping `timeoutMs`). `classifier.timeoutMs` is inert in the same way: it parses, is ignored, and is reported.
- **The deprecated top-level `{ "background": … , "questions": … }` `instructions` shape is rejected.** Wrap it in `classifier`: `{ "instructions": { "classifier": { "background": …, "questions": { … } } } }`.

**Registry classifier backend.** Run the Jev reviewer through Pi's built-in classifier: set `"modelType": "classifier"` on a string provider (`{ "provider": "typesafe", "model": "jev-latest", "modelType": "classifier" }`, pi 0.99+) instead of configuring a direct TypeSafe connection — no API key in config, auth lives in Pi. A registry primary missing from Pi's catalog fails the session; a missing registry fallback is skipped with a warning. A failed `classify` call is reconstructed as the SDK error its message describes: a status-bearing failure — including one that stopped `aborted` — classifies by that status first, so a refusal never fails over, and the endpoint's audit identity carries Pi's provider id (its registry name) rather than the direct SDK's `typesafe/` prefix.

**`classifier` threshold block (renamed from `typesafe`).** The block is now `classifier.intentThreshold` / `riskThreshold` / `confidenceThreshold`, matching the `classifier` lane and `modelType` vocabulary. It is now pure verdict policy and no longer carries `timeoutMs`: the primary reviewer's timeout is the top-level `timeoutMs` for the classifier lane exactly as for chat (a backup still overrides it with its own entry-level `timeoutMs`). Previously `typesafe.timeoutMs` overrode the primary timeout for a direct System One connection; the registry classifier added in this release never read it.

The old `typesafe` key still parses and its thresholds are still folded into `classifier`, but it is deprecated: it is folded **per layer**, before the layers merge, so a project's deprecated block still wins over the global layer's `classifier` block and the two never collide on the schema's both-keys rejection — only a single file writing BOTH keys is rejected. Loading a config that still uses the alias reports a deprecation notice, and `typesafe.timeoutMs` — like `classifier.timeoutMs` — keeps parsing so existing configs do not fail to load, but it has no effect; the loader reports it so the migration to the top-level `timeoutMs` is not silent. The connection spelling `provider: { type: "typesafe" }` is unchanged.

**Lane-uniform `instructions`.** A **string** now appends the same content to both lanes instead of replacing a chat model's built-in rules: for chat it is added after the built-in safety rules, for the classifier it is the shared background as before. This is the safe direction — an existing string can only make the reviewer stricter, never silently drop the built-in policy — but it does change what a chat-mode string does. Use a `chat` slot with `replace: true` to keep the old replace behavior.

The object form is now per-lane slots:

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
- Only the `chat` slot takes `replace: true`, which swaps the built-in safety-rules block for the slot's content instead of appending to it. The classifier lane is append-only: its built-in reviewer background, questions, and criteria are the answer contract the verdict thresholds are calibrated against (the background sentence defines the "authorization anchor" the `intent_match` criteria read against), so nothing there is replaceable. The verdict output format is likewise never replaceable.
- The old top-level `{ background, questions }` shape is gone: wrap it in `classifier`. Unknown keys are rejected, and so are an empty slot and a slot for a lane the configured pool never contains. (A lane declared only by a fallback can still go unused if the admission gate later skips that fallback — that skip is reported, so it is not silent.)
- A lane the object leaves out keeps its full built-ins; the loader reports it as a notice, so a partly covered pool (for example a chat primary with a classifier fallback and only a `classifier` slot) is never silent.

**Saving never writes an expanded secret.** A leaf whose owning layer spelled it as a `${VAR}` ref is written back as that ref — including when the target layer did not hold that leaf yet (a whole new file, or one new key): the save used to write the expanded value there, which could persist a secret into a layer (often a committed project config) that only ever held the placeholder. The round-trip is still verified against the loaded snapshot, so a variable that disappears between load and save refuses the write instead of persisting a value the config would not load with. Alongside it: config messages never echo the value an unresolvable ref sat in (they name the variable), and `redactSecrets` now also covers `scheme://user:pass@host` URLs.

**Internals** (a pure move — no behaviour change). The switch/terminal tables both lanes depend on (`switchableStatusReason`, `availabilityReason`, `failoverReason`, `classifyFailure`) now live in one module, `review/failure-taxonomy.ts`, instead of a chat-side copy plus a classifier-lane duplicate that had already been edited in parallel — the chat lane reads them through an untyped-string adapter, the classifier lane through a typed-SDK-error one, over one matrix. The chat lane's tolerant JSON verdict parser moved out of the lane-neutral `model/model-verdict.ts` (which now holds only the shared verdict vocabulary) into `engines/chat/verdict-parser.ts`. New backend-equivalence tests drive both backends through the same seam, pinning the shared matrix and recording the two places where the backends genuinely disagree (pre-existing, fail-safe, previously undocumented): an unclassifiable registry failure is retryable (the facade reconstructs it as a connection error) while a direct one is terminal, and `"timed out"` wording fails over through the facade but not through a direct generic error.
