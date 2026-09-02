---
"pi-permission-ai-guard": patch
---

Terminal deny verdicts carry an appended agent-facing behavioral instruction: content denies (the review judged the request) tell the agent not to rephrase, retry, or work around it and to have the user re-request explicitly; machinery denies (the review failed) tell the agent the reviewer itself failed and a later retry is legitimate. The instruction rides only the returned verdict's reason — the audit record's `emittedReason` and the operator notify lines keep the un-instructed teaching reason. First live feedback: the verdict section's reason contract now also forbids asserting what the reviewer cannot see (the user's intent, the conversation, invented details) — real denies had claimed "without explicit user intent" for an approval that existed in the conversation the reviewer never sees, and had invented a lock-file detail.
