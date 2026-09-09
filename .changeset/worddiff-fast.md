---
"pi-pigment": patch
---

word-diff range extraction is ~36% faster: one allocation-free pass per changed chunk replaces the slice-and-recount walks.
