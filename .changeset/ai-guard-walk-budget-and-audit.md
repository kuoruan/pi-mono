---
"pi-permission-ai-guard": patch
---

The classifier lane's published walk budget is now real, and a failed attempt is never missing from the audit log.

- A classifier walk can no longer run past `walkBudgetMs`: the call carries the walk's remaining budget as a signal, passed into the request (pi-ai ≥0.99 forwards it) and raced locally, so a version that ignores the option still cannot outlive the budget. The direct backend aborts outright. A single-endpoint walk keeps its transport retries, which is what made this matter: each SDK retry used to get a fresh per-attempt timeout.
- URL userinfo redaction now swallows a password that itself contains `@` (`https://user:p@ssw0rd@host`); matching only to the first `@` left the rest of the password on the line.
- A failover hop is audited only once the endpoint it leads to is actually contacted, so the review log no longer records a hop that the remaining budget then cancels.
- A failed classifier attempt is recorded where it is observed, so a retryable failure that a backup takes over still appears as `model_call_error`. Previously only the exhaustion path recorded it, and the chat lane already recorded its own — one walk now reads the same in both lanes.
- Saving a config no longer expands a prototype key: `${constructor}` / `${__proto__}` read as unset (fallback or skip) instead of expanding to a JavaScript prototype member that passed the value schema.
- The secret redaction pattern covers the scoped OpenAI key shapes (`sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`), which the older alphanumeric-only rule matched only up to the scope hyphen.
- A notice issued before the first session is no longer dropped silently: it warns, the same way a disposed UI context already did.
- A session-scoped setting change persists before the in-memory override is written, so a failed write leaves memory and the session file in agreement.
