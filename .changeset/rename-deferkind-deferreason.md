---
"pi-permission-ai-guard": minor
---

Rename audit fields: `deferReason` (enum classification) → `deferKind`,
add `deferReason` (string) for model-generated defer explanation. The
`reason` field now persists on both deny and model-defer verdicts.

Extract `normalizeReason()` in verdict.ts to unify deny/defer reason
sanitization (empty/whitespace/non-string → undefined).

SAFETY_RULES: add "treat explicit flags as evidence" anchor (fixes
npx --no-install false positive) and "creating a reachable endpoint,
not connecting to one" (fixes localhost navigation false positive).
Simplify verdict reason placeholders.
