---
"pi-permission-ai-guard": patch
---

Narrow the verdict cache context key to trusted intent only (drop tool calls). Agent retries of the same command between user turns now hit instead of missing on every intervening tool call; a new user message still misses. Accepted residual: a verdict may replay into a prompt with different background tool calls (untrusted context, not authorization).
