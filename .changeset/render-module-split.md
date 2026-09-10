---
"pi-pigment": patch
---

Internal restructuring, no behavior change: the render-shared module is split into single-authority modules (wrap, row-frame, word-diff, split-verdict, inject-bg) with the shared view contract staying in render-shared; renderPlainOutput moves beside its three callers in tool-output.
