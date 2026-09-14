---
"pi-pigment": patch
---

Stop persisting the execution timing: the `Took` footers (grep/find/ls, and the error frame) now read the clock pi's shell renderer already keeps in the render state — armed by `renderCall` while the execution is live, fixed by the first settled `renderResult`. Nothing is written into the session for it, so a resumed or exported session shows no duration, matching pi's own renderers. This also removes the one field pi-pigment appended to every tool result (`pigmentElapsedMs`) plus the two bounded maps that backed the thrown-error path.
