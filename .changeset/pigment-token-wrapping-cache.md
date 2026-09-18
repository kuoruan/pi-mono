---
"pi-pigment": patch
---

Token-to-ANSI rendering now caches the open/close escape pair per distinct color+fontStyle combination instead of parsing hex and rebuilding strings per token.
