---
"pi-permission-ai-guard": patch
---

Harden `shortHash` (verdict-cache keys, log correlation) from dual-32-bit Math.imul to 16-char SHA-256, so an agent-influenced command cannot preimage onto an allowed command's key and inherit its verdict.
