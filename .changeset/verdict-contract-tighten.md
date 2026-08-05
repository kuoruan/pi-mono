---
"pi-permission-ai-guard": patch
---

Tighten verdict output contract: require riskLevel for deny, require non-empty reason for deny and defer.

The model-facing verdict contract now uses explicit conditional field rules
instead of ambiguous "optional" bullets:

- allow: omit reason and riskLevel
- deny: reason (unsafe action + safer alternative) and riskLevel are both required
- defer: reason (what is unclear or what human confirmation is needed) is required;
  riskLevel optional

Also adds an explicit instruction to omit fields that do not apply and never
emit empty-string fields, addressing the observed empty defer reason and
absent deny riskLevel in production logs.

Internal contract unchanged: `reason` remains deny-only in the audit record;
`deferReason` remains the classified machine reason. The model's defer
explanation continues to be available in `rawReply` for `model-defer` outcomes.
