---
"pi-permission-ai-guard": patch
---

Collect the pipeline gates' release ritual into a `disposition` module: `releaseMachineryGate` (moved as-is) owns the four reviewer-failure gates' disposal, and the new `releaseVerdictGate` owns the cache-hit and fresh-model gates' mapping side effects (fail-open notice state, operator notice, `mapped()` record annotation, agent instruction on a returned deny). Zero behavior change: gates declare verdict + facts, the ritual lives in one module.
