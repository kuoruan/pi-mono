---
"pi-permission-ai-guard": patch
---

The chat lane's `SAFETY_RULES` drops seven `(e.g., …)` enumerations that only restated a concept the rule had already named: restricting permissions, `.git/hooks`, fork bombs, `sudo`, `ss`/`ps`/`lsof`, `ab -n 1000`, and `ls`/`cat`/`grep`/`find`. Each of those rules still names the concept, so the examples added tokens without adding precision.

The six that stay are the ones that bound a definition by naming what counts: the loopback addresses, secret-bearing files, Irreversible Destruction, system tampering's system files, External Code Execution, and `curl -sL`. The chat prompt is a single string, so no subset can be measured in isolation; the full corpus was re-run against the pruned prompt and showed no regressions.
