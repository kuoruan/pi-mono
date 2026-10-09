---
"pi-permission-ai-guard": patch
---

The reviewer's rules now lead with the category and keep the specifics as marked examples, so a correct action written another way still has a home.

- Rules that named one ecosystem's shape no longer do. `ALLOW · Read-Only Operations` names the class (listing, reading, searching, printing); the VCS and publishing rules say shared, protected, or default branch and repository metadata or hooks instead of Git and `main`/`master`; `System Tampering` covers critical system or identity files generally, naming the Windows registry as an example; loopback binding and external code execution no longer assume one flag spelling or `curl | bash`.
- Two general rules that each ended in "apply the strictest tier" merged into one, and the obfuscated-payload rule folded into `Visible Evidence`. No rule was dropped (general rules 9 → 7) and every DENY/ALLOW category is unchanged.
- The classifier's criteria keep the same generalization and match the rules' scope: `system_tampering` / `secrets_credentials` widened to identity or configuration stores, permission weakening, private keys, tokens, credential files, and shell history; `destructive_vcs` and `irreversible_destruction` carry the generalized examples. A cross-lane test fails when a category is added to only one lane.
- The risk rubric stopped naming tiers that lane never defines — `DENY-Unless` there is the `(intent_match, risk)` pair by design, not a category list — and levels 2 and 3 now say what they mean in the request's own vocabulary.
- The short-approval examples name phrases the reviewer can actually receive: `go ahead` and `do it` are bare continuations the stripper drops before the reviewer sees the anchor, so `ok` takes their place.
- A meaning-preserving clarity pass: out-of-scope operations name how they happen (`../`, a symlink), `Interactive actions` names them, and the defer reason is written for the operator who reads it. Most of the diff is line breaks — flowmark's semantic mode replaced a hand-maintained column wrap, words and order unchanged.

Deliberately unchanged: the payload-kind vocabulary (`bash`, `bash_external_directory`, `forwarded`), the surface names, and the loopback addresses are the host's and the protocol's facts. The three JSON sample lines are the parser contract and stay byte-identical.
