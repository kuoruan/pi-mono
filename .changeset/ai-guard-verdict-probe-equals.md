---
"pi-permission-ai-guard": patch
---

Recognize `verdict=` alongside `verdict:` when scanning malformed model replies, so a pseudo-JSON verdict like `{verdict="deny"}` stops the scan instead of being skipped as brace noise.
