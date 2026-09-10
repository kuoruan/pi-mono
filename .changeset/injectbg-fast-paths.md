---
"pi-pigment": patch
---

Background injection under diff lines is faster: escape-free lines skip the cell walk entirely, reset-sequence reinjection is a single indexOf pass (moved into the SGR grammar module), and styled rows no longer pay a wasted full-line ASCII scan before the real walk.
