---
"pi-pigment": patch
---

The unified view's plain-text fallback no longer runs jsdiff twice per paired line: the word-diff analysis now carries its change list, and the painter consumes it directly (~1.8× faster on the over-budget fallback path).
