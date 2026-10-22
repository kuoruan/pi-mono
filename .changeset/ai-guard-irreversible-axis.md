---
"pi-permission-ai-guard": minor
---

**A custom mode can now rule on proven-irreversible effects.** `customMode` gains `onIrreversibleEffect` (`allow` | `defer` | `deny`, defaulting to `defer`): how the row disposes a reviewer allow that met facts proving the effect cannot be undone. Every built-in rung keeps asking, and existing `customMode` blocks behave exactly as before without migration. Choosing `allow` passes the class of effect the operator accepts (the record names the facts and the ruling); `deny` blocks it outright. The deterministic screen's hard deny stays terminal under every ruling.
