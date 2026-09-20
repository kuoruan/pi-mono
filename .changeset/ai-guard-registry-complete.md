---
"pi-permission-ai-guard": patch
---

Route model calls through `ModelRegistry.complete` (peer floor `>=0.84.0`); key the verdict cache context on trusted intent only, so agent retries hit between user turns.
