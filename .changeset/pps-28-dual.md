---
"pi-permission-ai-guard": minor
---

Track pi-permission-system 28 with a dual-version peer range.

- The peer range accepts `^27.1.1 || ^28.0.0`: the API surface this extension consumes (the Authorizer seam, verdict types, session-keyed service registration) is identical across the two majors, verified by the full suite under both resolved versions.
- v28's breaking change — decision attribution (`authorizer_allowed`/`authorizer_denied` resolutions, the agent-side refusal render naming the deciding link) — sits upstream of this extension's interface and needs no code here. The effect is a gain: a link deny is now rendered to the agent as "the 'ai-guard' authorizer denied this call" plus our reason, so the corrective reason reads as policy rather than as the user's instruction.
- Development and tests resolve `^28.0.0`.
