---
"pi-permission-ai-guard": minor
---

SAFETY_RULES: sharpen tier fallbacks, intent routing, and category precedence.

- **DENY — Unless heading**: drop the misleading "(Requires clear,
  matching user intent)" parenthetical; each entry now declares its own
  fallback (DENY/DEFER), consistent with the three-tier principle.
- **Category Precedence (new General Rule)**: a single action matching
  multiple categories applies the strictest tier; Secrets & Credentials
  overrides any read-only or diagnostic category that would expose them.
  Fixes a gap where `ps`/`ss`/`lsof` exposing tokens, or `cat .env` as a
  CWD read, could be mis-allowed.
- **Intent routing restored**: Environment Mutations, External
  Publishing, and MCP/Skill/Tool Side-Effects default to DEFER (not
  DENY) when intent is absent, aligning with "Uncertain → DEFER" and the
  General Rule's `otherwise → DEFER`.
- **External Exposure / loopback**: outbound connections are no longer
  blanket-ALLOW (contradicted intent-gated network observation); they
  route under Network & Browser. Loopback dev/test servers are ALLOW only
  with an explicit loopback binding (`--host 127.0.0.1`/`localhost`/`[::1]`
  or a known-loopback-default framework); unexpressed/uncertain bindings
  DEFER (e.g. `python -m http.server` defaults to 0.0.0.0).
- **Page-script classification**: split the over-broad "extractions" —
  visible DOM inspection is ALLOW (with intent); reading
  credentials/session/auth state/cookies/localStorage/private app state
  follows Secrets & Credentials / Sensitive-Data Egress; DOM mutations
  are DENY — Unless; remote fetch/run is DENY — Always.
- **New DENY — Always categories**: Resource Abuse/DoS (unbounded/system
  resource exhaustion, with bounded load tests carved out as
  intent-sensitive); `.git/hooks`/`.git/config`/`.gitmodules` code-exec
  added to Destructive VCS; shutdown/reboot folded into Persistent
  System Changes.
- **Removed**: Self-Modification (redundant with intent-gated writes +
  System Tampering), Database/Service Writes and Container/Orchestration
  (overlapped bash chain eval + MCP side-effects).
- **Privilege-escalation divide made explicit**: persistent privileged
  entry points (setuid, sudoers, authorized_keys) are DENY — Always;
  one-time `sudo` for a single visible scoped command is DENY — Unless.
- **Wording**: simplified Unknown Commands ("DEFER by default; DENY only
  if behavior matches a DENY category"), restored the Sensitive-Data
  Egress anti-scope-creep clause, added obfuscated/encoded-payload
  handling, narrowed Resource Abuse examples.

CONTEXT.md principle 7: marked "intent matching is not required" as
relocated to the Intent-Based Routing rule (protective meaning preserved
at the routing layer; the entry-level string was misreadable).
