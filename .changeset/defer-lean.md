---
"pi-permission-ai-guard": minor
---

Reviewer defers carry a `lean` — the reviewer's directional inclination — and the mode ladder routes on it.

- The reviewer's defer output format includes an optional `lean: "allow" | "deny"` (omitted = neutral; the prompt anchors both directions: deny-lean names a visible danger pattern, allow-lean names a benign action with an unclear authorization link).
- `lenient` passes benign- and neutral-leaned defers but asks on danger-leaned ones (a deny-leaning doubt is an active alarm); every other mode treats the lean states as the suspicion order dictates — lean only moves a defer across the ask↔allow boundary, never into or out of the deny band.
- Lean is a routing signal only — never shown in dialogs or notify lines (anti-anchoring: the ask is the operator's judgment moment). It lives in the `ai_guard.decision` audit record (`lean: "allow" | "deny" | null`).
- Benign-leaned passes are silent (the model's own inclination confirmed; allows never notify) and never cached (defers are never stored — identical asks re-review fresh).
- Invalid lean values degrade to neutral; a defer is never invalidated by its lean. The breaker counts the model's verdict (a defer feeds no tier).
