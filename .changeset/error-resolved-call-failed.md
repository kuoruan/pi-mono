---
"pi-permission-ai-guard": patch
---

Classify provider errors resolved as non-thrown replies as `call-failed`.

pi-ai surfaces some provider failures (rate limits, proxy/WAF blocks) as responses with `stopReason: "error"` rather than thrown errors — these previously landed in the `empty-reply` bucket, mixing infrastructure failures with the genuine model-silence pathology the empty-reply retry targets. The retry still fires for fast error-resolved replies (transient errors deserve it); only the classification moves, so the decision log and the machinery-defer notice name the cause honestly — 405 storms now read as `call-failed`, and `empty-reply` counts only real model silence.
