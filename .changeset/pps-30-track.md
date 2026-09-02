---
"pi-permission-ai-guard": patch
---

Track `@gotgenes/pi-permission-system` 30 with a quadruple-version peer range (`^27.1.1 || ^28.0.0 || ^29.0.0 || ^30.0.0`).

30.0.0's breaking change replaces `ForwardedSessionApproval`'s `surface` + `patterns` with per-pattern `grants` — a field this extension never reads (its links rule on the request, not on the whole-session grant scope), so the API surface we consume is identical across all four majors and the dev dependency runs the full suite against 30.0.0.
