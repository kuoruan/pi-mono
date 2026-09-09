---
"pi-pigment": patch
---

Summary chips close with a bare reset: the header row's background is injected, so the chip stopping re-opens of `bgBase` can no longer overpaint the row tail with a stale canvas.
