---
"pi-permission-ai-guard": minor
---

The reviewer's configured `reasoning` level now reaches the provider. The chat lane called `ModelRegistry.complete`, whose low-level `stream` only understands `reasoningEffort` — the simple-layer `reasoning` option was silently dropped, so every review ran at the model's `off` level. It now calls `ModelRegistry.streamSimple(...).result()`, which translates `reasoning` through the model's `thinkingLevelMap` (clamping an unsupported level to the nearest supported one).

**Requires pi >= 0.86** (`registry.streamSimple` was added there); the three `@earendil-works` peer floors move from `>=0.84.0` to `>=0.86.0`. A host below it fails safe at session start instead of deferring every ask as `call-failed`. The registry-classifier backend still needs pi 0.99+ (admission-gated, as before).

Behavior when `reasoning` is on (the default `off` path is unchanged):

- On budget-based providers (Anthropic, Bedrock) `maxTokens` is an answer budget: the thinking budget is added on top, bounded by the model's own `maxTokens`. On effort-based providers it stays the cap.
- An unsupported level is clamped to the nearest supported one instead of being dropped to `off`.
- A virtual-model reviewer is routed correctly instead of failing the low-level chat-model assert.
