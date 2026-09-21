---
"pi-permission-ai-guard": minor
---

Add a Jev reviewer path: set `provider` to `{ type: "typesafe" }` to review through TypeSafe's Jev (System One) instead of an LLM. Thresholds live in a new `typesafe` section (`booleanThreshold`, `confidenceFloor`, optional per-attempt `timeoutMs`); `reasoning`/`maxTokens` are ignored in Jev mode, `instructions` overlays onto the built-in questions instead of replacing them, and ask fields are redacted before they leave, matching the LLM path.
