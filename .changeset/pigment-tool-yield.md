---
"pi-pigment": patch
---

Tool wrappers now yield to names another extension (or an SDK-passed custom tool) already claimed: before registering, the extension reads pi's merged tool registry and skips any of the seven built-in names whose source is not `builtin`, with a one-line notice per session. A resume/fork re-fire does not yield to the extension's own prior registration. Names claimed after pi-pigment's `session_start` fires keep pi-pigment's wrapper live under pi's load-order merge (the late registration is dropped with a conflict log); factory-time registration, the render kit, or `disabledTools` cover that case. See ADR 0005's addendum and `docs/integrating.md`.
