---
"pi-permission-ai-guard": minor
---

Two new `/ai-guard` subcommands. `report` aggregates the review log's tail and suggests copy-paste permission-rule fragments for asks that reached the model 3+ times, all in one trusted-intent context, with no terminal deny anywhere — evidence for the operator, never an applied rule. `denied` lists this session's model-gate denies (most recent first) and echoes the picked record's reason. The model-gate decision record now also carries the `contextHash` fingerprint (same value as the verdict-cache key's context hash), so audit readers can tell same-context repetitions from cross-context ones; deny history is session-memory, targets ride the record's redacted form.
