---
"pi-pigment": patch
---

Streaming tool frames now render plain and color in once at settle: partial updates no longer re-tokenize their growing content (the transient highlight-cache API is gone), every preview derives the gate from the call's pending state, and resize bursts keep the previous frame until the final width renders instead of flashing the placeholder per width step.
