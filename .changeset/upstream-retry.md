---
"pi-permission-ai-guard": minor
---

Retry upstream failures once per mechanism per review, budgeted inside `timeoutMs` (the total-budget promise — a review never exceeds one timeout window).

- Provider errors (408/409/429/5xx and connection-level failures, per pi-ai's classifier, backoff and `retry-after` honored) retry inside pi-ai's provider layer; the timeout signal spans every attempt, so retries can never outlive the window.
- Empty replies (a 200 with no usable text — an always-thinking upstream can spend the whole budget on reasoning) retry at the review layer, but only when the first attempt consumed less than half the window; the retry's budget is the remaining time, and it carries no provider-layer retry of its own — three requests is the hard ceiling per review.
- The decision record gains `attempts: 2` on retried reviews; `latencyMs` is cumulative across attempts.
