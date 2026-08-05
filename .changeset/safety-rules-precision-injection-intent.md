---
"pi-permission-ai-guard": patch
---

Tighten SAFETY_RULES: network rule precision, shell injection coverage, intent tri-state, and verdict contract.

**Network rule precision** (from production log analysis):

- "Data exfiltration (curl/wget to external endpoints)" → "Sending secrets, local data, or command output to external endpoints (curl/wget POST/upload)" — distinguishes GET from POST/upload
- "Network services accepting external connections" → "Starting services/listeners reachable by external clients (nc -l, python -m http.server, docker -p 0.0.0.0:...)" — distinguishes outbound connections from local listeners
- New "DENY — Unless" entry: "Read-only outbound fetch/navigation (browser navigation, web_fetch, curl/wget GET)" — allow with matching user intent, otherwise defer

**Shell injection coverage** (from code review):

- Chain rule now also covers command substitutions ($(), backticks), subshells (()), process substitutions (<()), and heredocs — not just &&/||/|/;
- Any dangerous nested command controls the verdict

**Intent tri-state** (from code review):

- Replaced ambiguous "uncertain about intent → defer" with explicit three-state: clear matching intent → allow; clear absence of intent → deny unless category states otherwise; insufficient evidence → defer
- Clarified "(none found)" means no retained evidence (bounded transcript window), not clear absence — clear-absence deny applies only when retained intent positively shows the action is outside scope
- Deletion operations tightened: "require explicit matching intent; otherwise deny" — no longer ambiguous whether "without intent" means clear absence or insufficient evidence

**Decision precedence** (from code review):

- New section: "DENY — Always beats DENY — Unless beats ALLOW"
- ALLOW read-only now explicitly excludes reading, copying, or exposing credentials/secrets (resolves cat ~/.ssh/id_rsa ambiguity)

**Secrets/Security weakening clarity**:

- "Secrets/credentials (.env, ~/.ssh, keys, tokens)" → "Secrets/credentials — reading, copying, modifying, or exposing secret files and values (.env, ~/.ssh, keys, tokens, ~/.bash_history)"
- "SSH keys, cron/systemd" → "modifying SSH authorized_keys, creating cron/systemd tasks"
- "Git force-push or branch delete to" → "Git force-push to, or deletion of"

**Verdict contract** (from production log analysis):

- Replaced ambiguous bullet descriptions with three compact JSON examples (allow/deny/defer)
- deny: reason + riskLevel both required; defer: reason required, riskLevel optional; allow: omit both
- "never use empty strings; omit fields that do not apply"

**Review trigger**: "Assess the above" → "Assess the permission request above and respond with your JSON verdict"
