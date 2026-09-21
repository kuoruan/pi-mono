---
"pi-permission-ai-guard": minor
---

Add a Jev reviewer path: set `provider` to `{ type: "typesafe" }` to review through TypeSafe's Jev (System One) instead of an LLM. Three built-in questions (`danger_category`, `intent_match`, `risk`) synthesize the verdict — allow needs matching intent plus risk below the deny line. Thresholds live in a new `typesafe` section (`intentThreshold`, `riskThreshold`, `confidenceThreshold`, optional per-attempt `timeoutMs`); `reasoning`/`maxTokens` are ignored in Jev mode, `instructions` overlays onto the built-in questions instead of replacing them, and ask fields are redacted before they leave, matching the LLM path.
