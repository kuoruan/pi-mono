---
"pi-pigment": patch
---

Session render state is now a per-session value (`RenderSession`) instead of module-level singletons: diff roots, the theme selection, the user-theme environment, and the converted-theme map are resolved once at `session_start` and carried by the session — the four `set*` writes and the ambient reads they fed are gone, and two sessions in one process can no longer leak theme state into each other.

Pinning that seam surfaced a real rendering bug, fixed here: Shiki keys its theme registry by name, and a created grammar's color map ignores a later same-name `loadTheme` — so two user theme files sharing a stem (a re-edited file, two projects in one process) rendered with the FIRST file's colors while reporting the new ones. File-channel themes now register under a content-distinct name (`stem~fingerprint`), matching the highlight cache's existing key. Bundled, enforced, and patched theme variants were never affected.
