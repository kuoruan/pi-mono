---
"pi-permission-ai-guard": patch
---

Recognize `verdict=` (in addition to `verdict:`) as an attempted-verdict signature when scanning malformed model replies, so a pseudo-JSON verdict like `{verdict="deny"}` stops the scan instead of being skipped as brace noise.
