---
"pi-pigment": patch
---

Paint grep/find matches as blocks: the match keeps its bold accent foreground over pi's own searchMatchBg background (the surface the TUI's search uses), and the match close re-opens the line canvas (toolSuccessBg) instead of a bare 49m so the row past the match keeps its background (`baseBg`, mirroring `baseFg`).
