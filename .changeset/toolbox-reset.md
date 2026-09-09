---
"pi-pigment": patch
---

grep/find toolbox lines close fg with channel-scoped resets: the old full reset killed pi's line-level frame canvas from each match onward, exposing the terminal default background.
