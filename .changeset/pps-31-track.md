---
"pi-permission-ai-guard": patch
---

Track `@gotgenes/pi-permission-system` 31 — the peer range becomes `>=27.1.1 <32.0.0` (the five-major OR chain collapsed into one bounded range: semantically identical over every published version — 27.0.x stays excluded by the floor, 32+ by the ceiling — and a future major needs one token instead of a new disjunct).

31.0.0's breaking changes are two bash-gate path-gating fixes (paths named as `for`/`select` loop operands and `case` subjects are now gated — the public API surface is byte-identical to 30.0.0, verified by diffing the shipped type declarations). 30.1 added `PermissionsService.isToolFullyDenied` (cross-extension tool pre-filtering) and 30.2 added a both-directions session grant at the ask prompt — neither is consumed here yet. The dev dependency runs the full suite against 31.0.0.
