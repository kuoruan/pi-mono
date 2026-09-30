---
"pi-permission-ai-guard": patch
---

Rewrite the `irreversible_destruction` criteria (Jev) and prompt section (LLM) as a positive definition: only data with no version-control or session recovery counts. Recoverable in-project deletions and unstage-only resets fall through to Deletions (DENY — Unless) instead of hard-denying.
