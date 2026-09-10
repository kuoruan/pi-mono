---
"pi-pigment": patch
---

Edit and write previews now build the grammar seed only for the languages that embed another syntax (vue, html, php, markdown, ...). A TypeScript or Python preview no longer reads the file from disk and tokenizes a whole-file prefix for a seed that cannot change a single token, the read is memoized once per call instead of restat'ed per re-render, and a prefix past 64KB falls back to the unseeded render rather than a tokenize proportional to the file.
