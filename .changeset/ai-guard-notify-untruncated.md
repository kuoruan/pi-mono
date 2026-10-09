---
"pi-permission-ai-guard": patch
---

Operator-facing notices are no longer truncated, so the reviewer's whole reason reaches the human.

- The deny/ask notice (`reviewer denied this request (risk …); <reason>`) carries the model's reason whole. A clarification the operator has to answer is never cut mid-sentence.
- The defer notice (the model's own reason) likewise keeps the full clarification: the dialog alone never shows what the reviewer wants clarified.
- A failed config load names the complete first issue instead of a 100-character summary — the operator needs the whole message to fix the file.
- Prompt material and the audit record keep their own size bounds; those are not the user-facing copy.
