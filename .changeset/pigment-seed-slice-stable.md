---
"pi-pigment": patch
---

Resizing across the split/unified threshold no longer re-slices a diff's grammar seed: the seed now covers the diff's last hunk outright instead of the visible window's end, so narrow and wide renders share one seed and one set of highlight cache keys.
