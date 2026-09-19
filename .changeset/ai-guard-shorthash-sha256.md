---
"pi-permission-ai-guard": patch
---

Harden `shortHash` (verdict-cache keys, log correlation) from a dual-32-bit Math.imul hash to SHA-256 truncated to 16 hex chars — an agent-influenced command must not be able to preimage onto an allowed command's cache key and inherit its verdict.
