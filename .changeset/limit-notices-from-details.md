---
"pi-pigment": patch
---

Derive the truncation notices from the SDK's structured `details` instead of pattern-matching the output text. grep/find/ls append the notice as the output's last line and record the same fact in `details`; the wrapper now lifts that line out of the memoized body when a limit flag is set, so `ls` no longer renders the notice as a `└── [500 entries…]` tree row, a bracketed filename stays a path, and the notice never spends the collapse budget — it paints as the warning footer under the affordance line, like pi's native renderers.
