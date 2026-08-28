---
"pi-permission-ai-guard": minor
---

Add a `/ai-guard` runtime settings command: a mode picker with per-mode descriptions, a ctrl+alt+g shortcut cycling `default → lenient → permissive`, and save actions that persist the effective config (every field, session overrides included) into the global or project config — in-place JSONC leaf edits that preserve comments and formatting, refused for untrusted projects. Session overrides persist into pi's session file (custom entries, never LLM context) and restore on resume. The footer renders only deviations from the `default` baseline, with `permissive` in warning red.
