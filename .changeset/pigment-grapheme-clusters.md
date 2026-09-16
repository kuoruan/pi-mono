---
"pi-pigment": patch
---

Rows that carry grapheme clusters (combining marks, ZWJ emoji, flags, conjoining jamo, …) are now walked and measured by cluster, using pi-tui's own `visibleWidth`, so widths, wrapping, truncation and word-emphasis highlights match what the renderer draws; lines without cluster-forming code points keep the fast per-code-point path. The gate's code-point tail is derived from the runtime's `Intl.Segmenter` instead of a hand-copied chart — `pnpm run check:risky-tail` re-derives it — and now covers the Hangul jamo Extended-A/B blocks and the Kirat Rai joiners the previous ranges missed.
