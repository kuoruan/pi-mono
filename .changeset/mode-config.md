---
"pi-permission-ai-guard": minor
---

Add a `mode` config option (`manual` | `default` | `auto`, default `default`) deciding who adjudicates the model's non-allow verdicts.

- `manual`: every deny and defer goes to the human — the reviewer becomes an advisor whose deny reasoning surfaces as a notification.
- `default`: the shipped behavior — decisive denies are final, uncertainty asks.
- `auto`: fully automatic and fail-closed — everything that would otherwise fall to the human is denied: the model's own uncertainty carries its clarification request as the deny reason, and reviewer machinery failures (model unresolved, auth failed, transcript errors, timeouts, unparseable or empty replies) deny with the classified failure as the reason.
- The mode is switchable at runtime via the `/ai-guard` settings menu (two-stage argument completion) and the `ctrl+alt+g` cycle shortcut; session overrides persist into pi's session file (custom entries, never LLM context) and restore on resume, re-deriving on tree navigation.
- The footer renders only deviations from the `default` baseline.
- A tripped circuit breaker's forced verdict bypasses the mapping by design: the default forced deny keeps auto sessions uninterrupted; a configured forced defer interrupts the human as the reviewer-untrusted escape valve (the config loader warns about that combination).
- Save actions persist the current effective config (every field, session overrides included) into the global or project config file — in-place JSONC leaf edits that preserve comments and formatting, refused for untrusted projects; a saved field shadows the layers beneath it.
