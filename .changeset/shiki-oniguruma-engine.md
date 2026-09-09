---
"pi-pigment": patch
---

shiki tokenizes through the Oniguruma WASM engine (the canonical TextMate reference): realistic dense source renders 3-6x faster, cold first-tokenize ~3x, and the JS-regex engine's lazy-compile machinery — the grammar-state flake's root-cause carrier — is gone.
