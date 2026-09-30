---
"pi-permission-ai-guard": patch
---

Move the call-failure audit sink beside the audit cluster with no behaviour change: both engines import it from one place instead of the Jev lane depending on the LLM call module.
