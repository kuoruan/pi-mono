---
"pi-permission-ai-guard": minor
---

The classifier lane now receives the wrapper facts the chat lane already renders: `executed_unit`, `command_context`, and `matched_pattern` join the System One `state`, so a substitution, subshell, or wrapper ask is no longer reviewed on intent alone.

An ordinary ask's state is unchanged — the three keys appear only on wrapper-shaped asks. The classifier thresholds were calibrated without these facts, so a probability can move on exactly those asks. The chat lane is untouched, and a test-side lane-fact inventory now classifies every ask fact per lane so a future field cannot be silently dropped by one lane.
