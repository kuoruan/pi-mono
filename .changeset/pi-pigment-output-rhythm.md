---
"pi-pigment": patch
---

Unify the output tools' vertical rhythm: the collapsed tail's segments (expand hint, limit notice, Took) each take their own row with a blank line between and Took closing the tail (the native bash order); the body leads with a header gap (the native bash renderer's leading newline) and hugs a collapse hint (`... (N more lines)`) while a notice/Took-led tail breathes below a blank line (`joinBodyTail`); `collapsedView` returns the hidden count (`CollapsedWindow`) so wrappers stop recomputing it.
