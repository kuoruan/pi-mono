---
"pi-permission-ai-guard": minor
---

Add a four-mode leniency ladder — `strict`, `default`, `lenient`, `permissive` — deciding who adjudicates the reviewer's non-allow verdicts.

- `strict`: the reviewer's allow is the only pass (fail-closed automation).
- `default`: you judge every flag but hard danger — soft denials and every unresolved doubt ask you.
- `lenient`: only the reviewer's active alarms ask you (soft denials and deny-leaning doubts); benign and neutral doubts pass.
- `permissive`: only hard-tier denials block, and each such block notifies the operator.

Hard-tier denials (riskLevel high|critical, or missing) stay terminal in every mode. Reviewer machinery failures never map to allow: they deny under `strict` and `permissive`, defer under the other two, and every forced deferral announces its classified cause to the operator.

The ctrl+alt+g cycle visits `default → lenient → permissive`; only `strict` is set explicitly.
