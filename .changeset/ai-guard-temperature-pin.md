---
"pi-permission-ai-guard": patch
---

The chat lane now sends a `temperature` when the config sets one (`temperature: 0` in the extension config). Leaving it unset keeps the previous behavior: the field stays off the wire and the provider default applies. Classifier mode ignores it, because TypeSafe's request body carries no sampling parameter.

A `fallbacks` entry may set its own `temperature`, which wins over the top-level value. A backup is a different model, and some models reject non-default sampling (OpenAI reasoning models accept only their own default), so a pin that fits the primary does not necessarily fit the backup.

The reviewer parses its reply straight into a verdict, so an unpinned decode temperature shows up as the same request flipping between runs: a repeat-2 pass over the 87-case corpus classified 6 cases differently across their two runs at the provider default, and 2 at `temperature: 0`. A DENY-Always case that had been alternating between `deny` and `defer` settled on `deny`.
