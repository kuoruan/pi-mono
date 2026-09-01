---
"pi-permission-ai-guard": patch
---

The review prompt's trusted-intent section is now layered: the latest user message renders under its own "authorization anchor" heading (the request the agent is currently acting on), earlier messages under a separate context heading, and the Intent-Based Routing rule states the anchor doctrine. An experimental navigation change (principle 8), to be validated against live defer/lean data — not a fallback adjustment. Also fixes the `StrippedTranscript.trustedIntent` docblock, which misdescribed the array as "most recent first" (it is chronological).
