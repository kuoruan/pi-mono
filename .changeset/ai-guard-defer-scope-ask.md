---
"pi-permission-ai-guard": patch
---

A defer on a short approval now asks for the scope instead of only reporting the shortfall.

"Ok", "as you recommend", "rename it" names no action of its own — it points at agent text, which the reviewer never sees. Both lanes now read such an anchor as the user's own words authorize, and nothing more:

- The chat lane's safety rules judge a referential anchor by what the user's words actually name, and its verdict contract requires a defer reason for that case to ask the operator for the scope.
- The classifier lane's `intent_match` criteria carry the same rule, and its synthesized defer reason for an intent gap is `confirm the scope: is this action covered by your request?`.

The reviewer's synthesized reasons are now written for the operator, who is the one reading them:

- A defer on low confidence asks `is this action safe to run?` instead of reporting `unsure about this action (danger_category confidence 0.42 < 0.50)`.
- A danger-hit deny reads `matched a safety rule: system tampering`, not `matched rule: system_tampering`.
- The calibrated readings no longer appear in the operator's line — the audit record still carries every answer in `rawReply`, so the numbers stay available for threshold calibration.
