---
"pi-permission-ai-guard": patch
---

Terminal deny verdicts carry an appended agent-facing behavioral instruction: content denies (the review judged the request) tell the agent not to rephrase, retry, or work around it and to have the user re-request explicitly; machinery denies (the review failed) tell the agent the reviewer itself failed and a later retry is legitimate. The instruction rides only the returned verdict's reason — the audit record's `emittedReason` and the operator notify lines keep the un-instructed teaching reason.
