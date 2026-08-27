---
"pi-permission-ai-guard": minor
---

Add a `maxTokens` config option (default 4096) — the reviewer reply budget now leaves reasoning upstreams enough headroom that a thinking block can finish before the verdict JSON, instead of truncating mid-think into the empty-reply machinery failure.
