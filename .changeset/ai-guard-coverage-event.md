---
"pi-permission-ai-guard": patch
---

Emit a dedicated `ai_guard.coverage` debug breadcrumb (outside the machinery taxonomy) when an ask falls outside this link's surfaces, so a thought-covered-but-never-reviewed misconfig is discoverable when diagnostics are on. Behavior unchanged: the ask still defers.
