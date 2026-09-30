---
"pi-permission-ai-guard": minor
---

Label Jev risk-lane denies by the fixed quartile bands of the 0–4 rubric (low below 0.25, medium below 0.5, high below 0.75, critical at or above), independent of `riskThreshold` — `riskThreshold` alone decides the deny. With the default 0.5, every risk-lane deny reads high or critical and blocks in every mode including permissive, catching danger-missed destruction.

Derive the defer lean from the danger direction (risk over the line leans deny, a pure intent gap with trusted readings leans allow, otherwise neutral) so the mode ladder treats benign and danger-leaning doubts like the LLM lane. Treat responses with missing readings as malformed (machinery defer, never allow) instead of zero-projecting them.
