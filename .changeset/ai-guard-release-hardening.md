---
"pi-permission-ai-guard": patch
---

Release hardening across config loading, the review pipeline, the prompt material, and the audit trail. No existing configuration needs to change: every item moves in the fail-safe direction — degrade, defer, or warn, never a wrong deny.

**Config**

- A top-level key the schema does not know is now reported (`unknown key "surfces" — ignored (check for a typo)`) instead of being dropped in silence. The layer still loads, so a config written for a newer version keeps working; only the typo becomes visible.
- Saving a config whose deprecated `typesafe` block cannot be removed leaves the file untouched and says so, naming the key: "refusing to write — `typesafe` cannot be removed from this file". The write used to retry forever.
- Env refs resolve against own keys only, so a `__proto__` key can no longer feed a value into the effective config — and a config that contains one still loads.

**Prompt**

- The short-approval rule names the agent's own prose rather than "agent text". Tool calls are part of the prompt, so the old wording promised an absence the prompt did not keep.
- The trust boundary names the human's own words — what they type, and the choices they make — and says a choice authorizes the option it names and nothing wider, since the wording around it may be agent-authored. The old wording named `ask_user_question`, which the model never sees: only the answer text reaches the prompt, and one package's tool name is not the human.
- The short-approval clause no longer appears twice: the rule stays with the general rules, and the verdict format only says how to phrase the question the operator is asked.
- Wording for the authorizing person is now consistent: the authority sentences, the anchor definition, and the rendered transcript labels say the human, while transcript structure keeps "user" and the config owner is the operator. The classifier's background sentence called the anchor "the latest user request" although its state carries the trusted intent — which includes a question tool's answer — so it named a channel the answer did not come through.
- The defer instruction is qualified: the reason is the question the operator is asked _when the defer survives as one_. The strict and lenient modes map a defer to a deny, where nothing is asked.

**Review**

- A chat reply stating two different verdicts now defers to the human instead of taking the first. A self-contradictory reply must not decide.
- A deny without a reason notifies with the generic reason. It previously fell through to the defer branch and rendered nothing at all.
- Model-generated annotations are never rendered into the prompt and never reach the verdict; keeping them out of the verdict cache key is now correct by design rather than a coincidence.
- A question tool's result reaches the reviewer as the tool returned it: its structured payload as JSON when it carries one, its own text otherwise. Only two names are trusted, `ask_user_question` and `ask_user` — the ones whose names say _user_. Near-names such as `ask`, `ask_question`, or a model-delegation tool (`pi-ask-codex`) stay untrusted, because trusting them would let the agent's prose become the authorization anchor.
- The structured payload keeps the question text next to each answer, so the reviewer can tell what an answer authorizes. Nothing is re-rendered or summarized: the packages disagree on the shape, and a dropped field is authorization the reviewer cannot see.
- A cancelled questionnaire travels as its own payload (`cancelled: true`), so a refused or failed dialog is visible as such instead of arriving as the sentence the tool writes about it.
- The denied panel keeps the 50 most recent denials instead of growing for the life of the session.
- A reply whose first verdict object is unbalanced now defers instead of letting a later object decide the ask. The parser had only guarded the balanced case, so a malformed open brace could hand a later allow example the verdict.
- A provider refusal that arrives with "aborted" in its text stays terminal and is recorded as `call-failed`, not `timeout`. The defer kind is what the operator reads, and the classifier backend's error reconstruction no longer rebuilds such a refusal as a switchable timeout (or a switchable connection failure).

**Audit**

- The recorded `rawReply` is bounded (2000 characters, truncated in the middle), so a pathological reply cannot bloat the log.
- A policy pattern is redacted at the record factory, where every producer passes.
- A crashed review writes an `internal-error` record, so the log shows the failure instead of stopping at the pre-call gate.
- The log tail reader honors short reads: a window that only partially fills is no longer parsed as a truncated line.
- Suggested rules ignore patterns that were redacted on the way in.
- The crash record is written independently of the debug line, so a throwing debug sink no longer costs the audit trail the record that says the review crashed.
