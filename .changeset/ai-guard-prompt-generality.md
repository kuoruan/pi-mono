---
"pi-permission-ai-guard": patch
---

The reviewer's rules no longer describe one ecosystem's tools as if they were the rule, and the wording that could be read two ways was rewritten to mean one thing.

Several passages defined a category by a concrete list, or named one ecosystem's shape, so a correct action written another way had no obvious home. The rules now lead with the category and keep the specifics as marked examples:

- Two general rules that each ended in "apply the strictest tier" merged into one (`Strictest Tier`), and the obfuscated-payload rule folded into `Visible Evidence`. No rule was dropped; the general-rule bullets went from 9 to 7 and every DENY/ALLOW category is unchanged.
- `ALLOW · Read-Only Operations` was defined by a POSIX tool list; it now names the class (listing, reading, searching, printing) and keeps the tools as examples.
- `DENY — Always · Destructive VCS Actions` and `DENY — Unless · External Publishing` no longer name Git or `main`/`master`: the rules say shared, protected, or default branch, and repository metadata or hooks.
- `System Tampering` covers critical system or identity files generally, and names the Windows registry alongside the Unix paths.
- `Loopback Servers` no longer assumes one flag spelling, and `External Code Execution` no longer assumes `curl | bash` or a package manager.
- The classifier's `destructive_vcs` and `irreversible_destruction` criteria carry the same generalization, kept condensed from the rules, and `system_tampering` / `secrets_credentials` were widened to match the rules' scope (identity **or configuration** stores, permission weakening; private keys, tokens, credential files, shell history). A cross-lane test now fails if a category is added to only one lane.
- The classifier's risk rubric stopped naming tiers that lane never defines. `DENY-Unless` has no category list there at all — that tier _is_ the `intent_match` + `risk` pair, by design — and it sat on the level that is a hard deny at the default threshold, so the ambiguity leaned permissive instead of safe. Levels 2 and 3 now say what they mean in the request's own vocabulary (a deletion, out-of-scope write, or publishing action without clear matching intent; behavior resembling one of the danger categories above).

Deliberately unchanged: the payload-kind vocabulary (`bash`, `bash_external_directory`, `forwarded`) and the surface names are the host's contract, not an ecosystem assumption, and the loopback/any-interface addresses are protocol facts.

A clarity pass over the same copy, meant to be meaning-preserving:

- `retained evidence clearly outside scope → DENY` became `clear evidence the action exceeds the anchor's scope → DENY`, and the DENY — Unless default now says a category's own rule below prevails — a deletion without intent is DENY, not the default DEFER.
- "Judge an `executed unit` over its wrapper text" says what it means: when the request shows an executed unit, judge that, not the wrapper command text.
- Out-of-scope operations name how they can happen — via `../` or a symlink — and `../` is a path traversal, not a symlink.
- `Interactive actions` now names them (clicking, typing, form submissions).
- `an unseen command suffix` became plain English ("an unseen part of the command").
- The rules are laid out by flowmark's semantic-line-break mode — one sentence per line, longer sentences wrapped to 88 columns — rather than a hand-maintained ~74-column wrap. The words and their order are unchanged.
- Two output-contract bullets that both governed the reason merged into one, and "never assert what you cannot see" now names what is actually hidden (the agent's words, the unshown parts of the transcript) instead of "the conversation" — the review prompt does render earlier user messages, so that example invited the very assertion it forbade. The three JSON sample lines are unchanged; the prompt×parser seam test extracts and parses them.
