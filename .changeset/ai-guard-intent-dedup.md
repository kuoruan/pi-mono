---
"pi-permission-ai-guard": patch
---

Adjacent duplicate user messages collapse to one trusted-intent entry without consuming quota: repeated nudges no longer crowd the real task sentence out of the `maxUserMessages` window, which was starving the intent check of its authorization anchor. Exact match only; non-adjacent repeats keep their own slots.
