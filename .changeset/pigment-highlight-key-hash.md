---
"pi-pigment": patch
---

The highlight cache key now carries the code's length plus its FNV-1a hash instead of the full source text, shrinking full-cache key memory from megabytes to kilobytes.
