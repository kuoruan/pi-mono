---
"pi-pigment": patch
---

Vue files with `<script lang="tsx">` (or any other embedded language) no longer render diff hunks uncolored: the highlighter now loads the embedded grammars the code actually references, guessed from the hunk and its seed text.
