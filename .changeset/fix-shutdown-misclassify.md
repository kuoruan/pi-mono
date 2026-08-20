---
"pi-permission-ai-guard": patch
---

Reclassify host shutdown/reboot from DENY-Always (Persistent System Changes) to its own intent-gated DENY-Unless entry, so an explicitly authorized shutdown or reboot is allowed instead of being denied regardless of intent.
