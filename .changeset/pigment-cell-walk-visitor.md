---
"pi-pigment": patch
---

The styled-text cell walk no longer allocates a record per cell: `forEachCell` visits a cell's span, column count and escape flag as primitives (its generator predecessor yielded one object per cell and measured 3–8x an inlined walk, the allocation being the bulk of it), and each call site slices the cell's text only when it needs it. Measured on the frame paths, per pair of interleaved runs against the previous code: styled-line width measurement ~5x faster, CJK ~2.5x, styled truncation ~2.5x, background injection with emphasis ranges ~1.4x; the plain-ASCII fast paths are untouched.
