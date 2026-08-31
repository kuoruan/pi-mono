---
"pi-permission-ai-guard": patch
---

Single-source the pre-call machinery-failure kinds: the four kind values (`model-unresolved`, `auth-failed`, `transcript-error`, `no-target`) live as one object constant in the new machinery-failure taxonomy module (which also owns the unified `MachineryFailureKind` union), every pipeline spelling site references the constant, `shortCircuit`'s reason is typed by the pre-call kind union, and `ask.ts` derives its `no-target` discriminant from the same value.
