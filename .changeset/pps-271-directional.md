---
"pi-permission-ai-guard": minor
---

Track pi-permission-system 27.1 and teach the surface matcher the directional path families.

- Dependency floor raised to `^27.1.1`. The 27.1 additions are compile-compatible (optional `floorExemption` audit field; the prompt payload's `kind` stays coarse), so no code change was required for the upgrade itself.
- Surface matching now knows the read/write capability axis: `path` and `external_directory` have `_read`/`_write` directional members that a proven-direction access routes to. Four granularities: the bare family (`"path"`) reviews both directions plus direction-unknown access; a member glob (`"path_*"`) reviews proven-direction access only; a directional member (`"path_read"`) reviews exactly that direction; a family exclude (`"!path"`) withholds its directional members too. A `_read` suffix over any other name stays its own surface.
