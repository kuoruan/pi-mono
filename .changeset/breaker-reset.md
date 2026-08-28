---
"pi-permission-ai-guard": minor
---

Give the circuit breaker an operator-visible trip and a manual reset.

- The total tier's first trip notifies the operator once per trip epoch: `circuit breaker tripped — total tier reached, blocking all reviews until /ai-guard breaker reset or restart`. Until now a total-tier trip was silent — the operator only discovered it from mysteriously denied commands (a heavy session with a deny-leaning reviewer burns the model-deny budget by volume, not failure). The notice rides the ambient channel at error grade: `notifyLevel` `off` silences it and consumes the once-per-epoch notice; the `error` threshold keeps it visible while silencing everything else.
- `/ai-guard breaker reset` (also the settings menu's last entry) clears both tiers. A pure counter reset: the verdict cache, mode, notifyLevel, and every session override survive it, and the confirmation notice says so. A session restart clears the breaker either way.
- Consecutive-tier trips stay quiet (they self-heal on the next allow; their per-ask machinery notices already speak on the defer lanes).
