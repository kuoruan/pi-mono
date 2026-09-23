---
"pi-permission-ai-guard": patch
---

Provider error text is truncated to 300 chars before it reaches the log: error pages (e.g. Cloudflare HTML from a WAF block) no longer land unbounded in debug records, where the transcript would feed them back into the next request's state and get the call blocked again. Applies to thrown call failures on both engines and to `reply.errorMessage` on the empty-reply path. The danger Choice criteria were also slimmed to descriptive wording after literal attack spellings accumulated enough WAF score to 403 the whole call.
