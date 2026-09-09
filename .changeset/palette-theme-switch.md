---
"pi-pigment": patch
---

Re-key the palette from theme content instead of theme-object identity: pi swaps the Theme instance behind a constant module proxy, so identity memoization pinned the first theme's palette and kept diff bodies and stats chips stale after a /settings theme switch.
