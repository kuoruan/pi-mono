---
"pi-pigment": patch
---

Multi-hunk diffs with grammar seeds (vue/svelte/…) settle noticeably faster: the seed's grammar state is now computed once and shared by every hunk block instead of being re-tokenized per block.
