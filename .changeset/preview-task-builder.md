---
"pi-pigment": patch
---

Internal restructuring, no behavior change: a definePreviewTask builder derives a preview task's identity and cache key from one stamp list, absorbing the width-appended and width-neutral key conventions the six wrappers previously hand-copied.
