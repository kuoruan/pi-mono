---
"pi-permission-ai-guard": patch
---

Fix the verdict-cache context key covering only trusted intent while the review prompt also renders untrusted tool calls — an intervening tool call could hit a verdict reached for a different prompt. The context hash now mixes both transcript sections.
