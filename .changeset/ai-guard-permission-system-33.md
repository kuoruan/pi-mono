---
"pi-permission-ai-guard": patch
---

Widen the `@gotgenes/pi-permission-system` peer range to `>=27.1.1 <34.0.0` and move the dev dependency to `^33.0.3`. No code change: the 33.x public surface is identical (verified against 33.0.3 — `tsc` clean, 623 tests pass), and the pipeline only reads the policy verdict state, so the 33.0.0 MCP matching changes only route more asks through the existing policy pass-through gate.
