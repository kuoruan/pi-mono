---
"pi-permission-ai-guard": patch
---

Stop three ways the guard could fall silent or mislead: a failed registration now retries on the next session instead of latching for the process lifetime; an unexpected pipeline crash still defers but says so on the notify line; and a session whose config failed to load clears the footer instead of leaving the previous session's mode on display.
