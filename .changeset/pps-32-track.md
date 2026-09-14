---
"pi-permission-ai-guard": patch
---

Track `@gotgenes/pi-permission-system` 32 (peer range `>=27.1.1 <33.0.0`). The v32 breaking change — a UI-bearing subagent relays its asks to its declared parent instead of adjudicating locally — moves this extension's link up one hop rather than removing it: a relaying node runs no chain, and the serving parent adjudicates the forwarded ask through its own chain, this link included. The API surface this extension consumes is unchanged across v31 and v32.
