---
"pi-permission-ai-guard": patch
---

Route model calls through `ModelRegistry.complete` (upstream tightened the provider input; requires pi >= 0.84). Key the verdict cache context on trusted intent only, so agent retries hit between user turns.
