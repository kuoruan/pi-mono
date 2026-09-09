---
"pi-permission-ai-guard": patch
---

Track `@gotgenes/pi-permission-system` 31 — the peer range becomes `>=27.1.1 <32.0.0` (the five-major OR chain collapsed into one bounded range: semantically identical over every published version — 27.0.x stays excluded by the floor, 32+ by the ceiling — and a future major needs one token instead of a new disjunct).

31.0.0's breaking changes are two bash-gate path-gating fixes (paths named as `for`/`select` loop operands and `case` subjects are now gated). The 31.1.x patch line (31.0.1 → 31.1.3) keeps the public API surface byte-identical — diffed shipped declarations show only a docblock relocation — so no code changes: 31.0.1 consults both path directions for an unresolved redirect, 31.0.2 prompts on a bash command whose parse could not be resolved (fail-closed: those asks now legitimately reach the chain and fall back to the review's safe defers), 31.1.0 records effective tool-surface changes in the debug log, and 31.1.3 states each session's own tool list — none of which this extension consumes. 30.1 added `PermissionsService.isToolFullyDenied` (cross-extension tool pre-filtering) and 30.2 added a both-directions session grant at the ask prompt — neither is consumed here yet. The dev dependency runs the full suite against 31.1.3.
