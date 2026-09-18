---
"pi-pigment": patch
---

Extract the grammar-state seed lifecycle into `theme/seed.ts` (language gate, last-hunk slice rule, character cap, shared grammar-state cache, edit/write seed sources) and language detection into `theme/language.ts`. No behavior change: `highlight.ts` keeps re-exports so existing importers work.
