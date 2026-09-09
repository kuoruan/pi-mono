---
"pi-pigment": patch
---

The write tool's create-preview stats (line count + content fingerprint) are now memoized by content reference in the render state — renderResult re-runs on every updateDisplay, and settled args are frozen, so each frame paid two full content scans for values that never change within a call.
