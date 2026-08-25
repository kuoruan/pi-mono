---
"pi-permission-ai-guard": minor
---

BREAKING: adopt pi-permission-system v27; the v26 peer range is dropped — consumers must upgrade.

- Session-keyed permission services: the link registers once per session on the node's own service, with the `permissions:ready` payload as the official session-id source; hosts without a session id keep deferring (see ADR 0001).
- One extension instance per session node (each node has its own lifecycle) — subagent children register their own link instead of reusing the parent's.
