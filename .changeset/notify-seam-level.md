---
"pi-permission-ai-guard": minor
---

Centralize the notify seam and add an ambient-notify threshold.

- All notify traffic routes through one session seam: the `[ai-guard]` prefix, the disposed-runner guard, and the level gate live in a single place — copy writers emit bare messages and no call site can forget the prefix or crash the verdict path. Command feedback (`/ai-guard` answers) rides the same primitive ungated.
- New `notifyLevel` config field (`info | warning | error | off`, default `info`) gates ambient (review-loop) notices by threshold: `warning` silences the `reviewer asks` mirror, `error` keeps only the total-tier breaker trip (the one ambient error line), `off` silences every ambient line. Command feedback is never gated — silence on a typed command reads as breakage. A non-default value renders a footer fragment (e.g. `off · lenient (session)`), so a silenced pane stays visible.
- `notifyLevel` is also a `/ai-guard` runtime setting (picker entry, direct form, session-scoped override that survives resume; `ctrl+alt+g` stays mode-only).
- Guard-absent errors ride the ungated feedback channel at error grade: a fail-safe config start (no auto-review), a failed authorizer registration, and a stale registration surviving disposal each notify the operator directly — the guard being absent or mis-slotted must never hide behind a level threshold or a console log.
