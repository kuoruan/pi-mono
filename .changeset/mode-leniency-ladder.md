---
"pi-permission-ai-guard": minor
---

Add a five-mode leniency ladder — `strict`, `default`, `advisory`, `lenient`, `permissive` — deciding who adjudicates the reviewer's non-allow verdicts.

- `strict`: the reviewer's allow is the only pass (fail-closed).
- `default`: decisive denials are final; uncertainty asks (the shipped behavior).
- `advisory`: soft denials and uncertainty ask; only the reviewer's hardest calls stay final.
- `lenient`: only the reviewer's active alarms ask; uncertainty passes.
- `permissive`: only hard-tier denials block, and each such block notifies the operator.

Hard-tier denials (riskLevel high|critical, or missing) stay terminal in every mode. Reviewer machinery failures never map to allow: they deny under `strict` and `permissive`, defer under the other three, and every forced deferral announces its classified cause to the operator.
