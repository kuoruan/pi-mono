---
"pi-permission-ai-guard": minor
---

Support `${VAR}` / `${VAR:-default}` / `$$` env interpolation in config string leaves (including inside `fallbacks[]`), and keep `${...}` placeholders intact on save: persisting restores on-disk placeholder text instead of writing expanded secrets back, across append/prepend/remove/reorder. A placeholder whose variable vanished since load also keeps its on-disk text (the integrity gate refuses the write rather than leaking the secret).
