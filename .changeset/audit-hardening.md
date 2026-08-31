---
"pi-permission-ai-guard": patch
---

Harden the audit and sanitize surfaces found by the full-package review.

- The decision record's `target` field now goes through the same normalize-and-redact as every other untrusted field — a credential inside a reviewed command no longer lands unredacted in the always-on review log.
- The sanitizer strips bidi directional controls (U+202A–202E, U+2066–2069): an RLO can make a command visually read as its reverse in a prompt, notify line, or audit record.
- The registration-failure notice drops its structural colon (the TUI's own level prefix would double it); a skeleton test now scans every static notify literal so the colon-free shape cannot drift back.
