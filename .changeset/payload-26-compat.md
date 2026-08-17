---
"pi-permission-ai-guard": minor
---

Support pi-permission-system 26.0's structured prompt payload while keeping legacy message compatibility. `buildActionText` reads the bash full command from `payload.evidence` (the `full command` entry, present when it differs from the sub-command) on 26.0+ hosts, and falls back to parsing the legacy `message` framing on older hosts, so the `>=20.10.0` peer range still holds. Bump `@gotgenes/pi-permission-system` devDependency to ^26.0.0.
