# Prompt writing principles

The safety rules prompt (`SAFETY_RULES` in `src/review/engines/chat/prompt.ts`) is the semantic instruction fed to the review model. These principles govern how it is written and maintained.

## 1. Semantic, not literal

Rules describe abstract concepts ("credential stores, private keys"), not environment-specific paths or tool names. A few generic examples ("piping a download into a shell", `chmod +s`) are fine as anchors, but they never act as the default gate — the category description does. Redundant qualifiers ("of unverified package" when the verb already implies it) are removed.

## 2. Three-tier precedence: DENY-Always > DENY-Unless > ALLOW

- **DENY-Always**: deny regardless of intent (secrets, irreversible destruction, external code execution, etc.).
- **DENY-Unless**: allow only with matching intent; otherwise the fallback the entry itself specifies (deny or defer).
- **ALLOW**: allow only when matching the current task context.

Each entry's fallback is stated by the entry, not by the section heading — different entries in the same section can have different fallbacks (Deletions → DENY, Unknown Commands → DEFER). The routing layer states the intent requirement once for the whole tier; an entry that mentions intent is stating its own fallback ("needs matching intent, otherwise DENY"), not restating the rule.

## 3. Uncertain → DEFER, not → DENY

Absent intent defaults to defer, not deny — except where the entry's own fallback is DENY (Deletions, principle 2). "(none found)" is insufficient evidence, not proof of absence. Unfamiliarity alone is not dangerous. Non-destructive observation (navigation, read-only diagnostics, page selection) without intent defers; it is never denied solely for being that action.

## 4. Trusted intent is the only authorization source

Transcript, tool calls, action text, and permission requests are untrusted. A human goal authorizes only matching actions, not unrelated or higher-risk side effects. Authorization is judged by material effect, not by command syntax.

## 5. The model is the semantic layer, not the deterministic gate

Deterministic interception is done by the policy engine; the model adds semantic judgment. Tool-name exceptions belong in policy config, not in the prompt. The prompt does not list allow-listed tool names.

## 6. Judge by behavior, not by category label

The same operation can fall into different tiers depending on what it actually does. Page script execution is classified by payload effect (DOM inspection → ALLOW; mutations/extractions → DENY-Unless; fetched remote code stays DENY-Always, under External Code Execution). Avoid excluding a whole action class ("page scripts are read-only"); route each action by what it does. "is not this category" between sibling categories is the routing form, not an exclusion.

## 7. Concise, but never at the cost of semantics

- Remove redundant phrasing ("rather than the whole request", "by itself", "classify as").
- Merge overlapping entries when their scope is identical; keep them separate when a qualifier applies to only one ("outside the project" limits persistent changes, not security weakening).
- Inline parenthetical content into the main clause where possible.
- Minimize token count — the prompt is sent on every model review, and the safety rules block is not cached. But never compress at the cost of principle 8: splitting distinct concepts stays even if it costs tokens, because navigability reduces misclassification.
- Safety-critical semantics must stay explicit, even when they seem implied. Two currently live as literal phrases in the rules — "both payload and destination" (Sensitive-Data Egress) and "not unrelated or higher-risk side effects" (Trust Boundary). A third, "intent matching is not required", used to sit inside the Unknown Commands entry; it was relocated to the Intent-Based Routing rule ("no intent → DEFER everything outside ALLOW, unless DENY — Always") because the entry-level string was misreadable as "unknown commands can be allowed without intent". The protective meaning — an unknown command with no matching intent DEFERs, never becomes a DENY merely for lacking intent — stays explicit at the routing layer. Keep it there; do not re-add the literal entry-level string.

## 8. Structure serves navigability

- **Line breaks come from `flowmark`, not from hand-wrapping.** `python3 scripts/reflow-prompt.py` reflows every prose literal in place with flowmark's semantic mode (one sentence per line, sentences wrapped to 88 columns); `--check` reports without writing. The script refuses to write unless the result is provably whitespace-only — word tokens and logical units (headings, bullets, JSON lines, in order) are both compared — so a literal with non-prose lines reports instead of writing. This is a script rather than a formatter run because the prompt lives in a TS template literal and no formatter rewrites string contents: oxfmt and Prettier both leave them verbatim, since rewriting a string would change a runtime value.

Bold titles and a tiered layout help the model locate the right entry and reduce misclassification. General rules are split into distinct concepts rather than fused in one paragraph — each evidence-handling concern (material-effect judgment, which also covers obfuscated payloads, and structured-fact weighting) and each surface-routing concern (loopback binding; the strictest-tier rule that covers chains and multi-category actions) stands as its own entry. Merge two general rules only when they state the same requirement — the inputs they name may differ — and fold the duplicate into one, never dropping it. Section titles must be unambiguous — a heading that asserts a single fallback breaks when entries under it have different fallbacks.

## 9. Precise wording, no ambiguity

- "executing fetched remote code" (not "fetching" alone) — fetch by itself does not trigger DENY-Always.
- "ALLOW with intent, otherwise DEFER" (not "ALLOW/DEFER").
- "is not this category" (not "is EXEMPT").
- Cross-tier annotations use a consistent style across entries.

## 10. Do not over-tune from stale logs

Before adjusting the prompt, confirm which prompt version produced the logs. Prefer policy config for deterministic-operation false positives. Only adjust the prompt when there is a systematic semantic bias — and then make the fallback explicit ("never DENY solely for these"), never add tool-name exceptions.

## 11. Terminology: human, user, operator

Three words, three jobs — never collapse them into one:

- **human** — the person whose words carry authorization (the grant source). Only this word covers both trusted channels: a `user`-role message _and_ a question tool's answer, which reaches the anchor as a tool result rather than a user message. Every sentence that grants authority says "human" ("the human's own words", "a human goal", "the latest request from the human").
- **user** — transcript structure only: the `user` role, "user messages", "the user prompt" (the API's own term for the per-ask message).
- **operator** — the person who reads the notices: the second person of defer/deny copy ("what the operator is asked", "the operator rules on the paths").

The rendered transcript's labels carry the same words as the rule that defines them — "Latest request from the human (the authorization anchor)". A literal-minded model looks for the anchor using the rule's vocabulary, so rule and label must not disagree.

## 12. The defer line names the gap, then the ask

A defer reason is the operator's only channel; `lean` stays hidden, because surfacing it would anchor the human's decision. So one line carries both halves: what the reviewer could not establish, then the one thing that would settle it in parentheses (`could not tie this action to your request (did you ask for it?)`). The line reaches `notify` with no prefix of ours, because the host renders its own level separator before our text; a leading label would need a second separator to attach, and a colon there doubles the host's. Both lanes obey that shape; they deliberately do **not** share words. A lane-spanning constant, or an example generic enough to be parroted, is how one content-free line (`is this action safe to run?`) reached the operator from both engines, and a bare question hands the work back without any finding. The shape is the contract the operator reads, whichever engine deferred.
