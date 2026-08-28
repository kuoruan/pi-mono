---
"pi-permission-ai-guard": minor
---

Make operator notices honest about outcomes, complete in content, and consistent in shape.

- A model deny that holds or escalates notifies in every mode: v27 renders no dialog for denials (the reason goes to the agent and the audit log only), so the notify line is the operator's only copy. A mode-softened deny ends `— asking you instead`; a deny that holds needs no tail. `permissive` swallows soft denies whole (zero-interruption contract) — only its hard-tier blocks notify.
- Model reasons and clarifications go out whole in notify lines, with a 240-char defensive ceiling (`NOTIFY_REASON_CEILING`) that only a runaway model hits; the audit record keeps the full text either way.
- The reviewer prompt binds reason to verdict: a deny reason must state what makes the request dangerous; an assessment that concludes the request is safe must be an `allow`.
- Truncation markers are single-line everywhere (`[...truncated...]`, no embedded newlines) — notify lines never break into multi-line artifacts, and transcript entries keep the stripper's single-line doctrine.
- Notify copy follows one skeleton (event sentence + em-dash consequence + parenthesized qualifier; state echoes stay `key = value (source)`), and the save-success line stays within it: the shadow-layer fact lives in the README (a saved layer can still be shadowed by a higher-precedence one).
