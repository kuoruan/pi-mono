---
"pi-permission-ai-guard": patch
---

Count the reviewer's own refusals as terminal for `/ai-guard report` candidate groups — a model deny the mode escalated from a defer (`emittedVerdict`) now disqualifies the group, and a valid-JSON non-object log line (`null`) is skipped like any corrupt line instead of crashing the panel.
