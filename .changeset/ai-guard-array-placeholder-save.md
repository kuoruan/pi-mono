---
"pi-permission-ai-guard": patch
---

Saving a config can no longer write an expanded secret over an array-held `${VAR}` placeholder.

- When an env ref inside an array (`fallbacks[].provider.apiKey` and friends) could not be expanded at save time — the variable was rotated away, or simply not exported in the shell doing the save — the write fell back to the in-memory snapshot and put the **expanded secret** into the file, which is usually a committed project config. The remaining disk elements are now searched for the placeholder rather than pairing by position, so neither an element inserted ahead of it nor a reordered array hides it: the value that reaches the file is the ref, never the secret.
- In that situation the save is refused, with the drift named (`a ref at fallbacks no longer resolves`) rather than the unrelated duplicate-key message it used to report. A leaf with no placeholder to preserve — including an in-memory edit over a ref that still resolves — is written normally.
