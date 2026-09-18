---
"pi-pigment": patch
---

Unify the visible-window slicing for the unified and split diff views in `render/visible-sources.ts` (`unifiedWindow`/`splitWindow`: window slice plus aligned highlight sources in one return). No behavior change: both views consume the same aligned pairs they hand-built before.
