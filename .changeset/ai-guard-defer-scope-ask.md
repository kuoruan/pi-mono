---
"pi-permission-ai-guard": patch
---

A defer on a short approval now asks for the scope instead of only reporting the shortfall.

- "Ok", "as you recommend", "rename it" names no action of its own — it points at agent text the reviewer never sees. Both lanes read such an anchor as the user's own words authorize, and nothing more.
- The chat lane's safety rules judge a referential anchor by what the user's words actually name, and its verdict contract requires that defer reason to ask the operator for the scope.
- The classifier lane's `intent_match` criteria carry the same rule; its synthesized reason for an intent gap is `confirm the scope: is this action covered by your request?`.
- Synthesized reasons are written for the operator, who is the one reading them: a low-confidence defer asks `is this action safe to run?`, and a danger-hit deny reads `matched a safety rule: system tampering` rather than `matched rule: system_tampering`. The calibrated readings stay available — the audit record keeps every answer in `rawReply`.
