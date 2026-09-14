---
"pi-pigment": patch
---

Internal restructuring, no behavior change: the pi extension entry moves out of `src/` to `index.ts` beside it, matching the other extensions in this repo. package.json `exports` and `pi.extensions` point at `./index.ts`, so loading and importing are unchanged.
