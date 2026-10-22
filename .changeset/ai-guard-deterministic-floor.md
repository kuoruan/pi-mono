---
"pi-permission-ai-guard": minor
---

**A reviewer allow can no longer silently pass an irreversible action.** When the deterministic facts prove the effect cannot be undone — a history rewrite, a recursive delete outside the working directory, a persistence install, an all-interfaces listener, credential-shaped data handed to a sending command, or a raw device copy — an allow is raised to an ask in every mode, on both the fresh and cache-hit paths. Everyday commands are untouched: scratch paths, single-file deletes, named build outputs, and `git stash` still pass as before.
