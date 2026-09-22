---
"pi-pigment": patch
---

Shell failures read at a glance: bash/powershell call headers now carry the parsed failure badge inline as a muted `·`-separated suffix — `$ cmd · ✗ exit 1` (`✗ exit 143`, `✗ timeout 30s`, `✗ aborted`, and the new `✗ terminated` for the upstream "Command terminated without an exit code" status line) — composed fresh per frame outside the highlight cache, with the args' own `(timeout Ns)` declaration suffix gone (the badge is the one timeout wording). The settled success frame rides the symmetric plain check — `$ cmd · ✓` (bold, success-colored, after the same muted `·`) — pending frames stay bare. The error frame stays body-only on a recognized status line (its bare name header remains only for unrecognized shell failures), and the failure-kind color mapping lives in one home beside the ✗-prefixed label forms.
