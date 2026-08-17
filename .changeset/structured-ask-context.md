---
"pi-permission-ai-guard": minor
---

Drop pre-26.0 support (peer range now `^26.0.0`) and read the structured `PromptPayload` directly via a `buildAskContext` projection, giving the review model `kind`-dispatched facts it previously did not.
