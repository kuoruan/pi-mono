# Decisions

Audience: engineers who want to know why the rules are shaped this way. Final decisions and the evidence behind them. Sources: `adr/` and `policy.md`.

## ADR timeline

- **0001 — no root-slot fallback** (accepted). A misconfigured permission root never silently degrades to another slot: fail closed and ask, not guess.
- **0002 — defer-lean sublanes** (mode set superseded by 0012). A defer carries a lean so the mode table can map it: lean deny asks, lean allow asks toward allow, neutral asks without direction.
- **0003 — the model never redacts** (accepted). Redaction happens once, at the normalizer, before the model or the audit path ever sees the text.
- **0004 — JEV is the reviewer engine** (accepted). One reviewer engine per provider, chosen by `modelType: "classifier"`, with the failure taxonomy owned by the lane rather than the SDK.
- **0005 — pi-ai is the canonical classifier** (accepted). The lane's internal representation is pi-ai's classifier types end to end; a `provider` object is no longer accepted.
- **0006 — a model cannot hard-deny; the deterministic screen can** (accepted; replaces the risk-label floor). Deny authority, not the model's self-reported `riskLevel`, selects the mapping tier. A screen deny is hard in every mode; every model deny is soft (default asks, strict and auto deny). The deterministic screen (`src/review/screen/`, literal-command rules plus pipe-to-shell) runs after the policy gate and before the model. A model false positive now costs one ask instead of an unliftable block.
- **0007 — the model answers observable questions; code decides** (accepted). The model answers only what the record shows — `ban`, `effect`, `target`, and (only with a trusted anchor) `intent`. Everything deterministic (path scope, build-output names, sensitive names, history rewriting, network reach, anchor existence) moves into code facts; a single decision table maps to exactly one of five verdicts without reading the mode. Corpus expectations derive from blind impact records, never from the rule set, so the rule set cannot certify itself.
- **0008 — the security boundary is not the parser** (accepted). The deterministic screen (and a host sandbox, where one exists) enforces; the AST facts triage (escalate, or prove a bounded scope, never a semantic guarantee); the model supplies semantics (no hard deny, no solo release, `absent` is not an exclusion proof). A shape the parser cannot rate is `unproven` and asks. Evidence: one leading vendor runs bash under `bubblewrap`/`seatbelt` isolation and documents text-matching deny rules as bypassable; another uses `seatbelt`/`Landlock`. Wiring the lanes needs its own authorization and a freshly frozen set (ADR 0010).
- **0009 — protection weakening is a conjunction** (accepted). Facts record word-level structure only: `grantsBeyondOwner` states a group or other grant, never "this widened the file". The table escalates on `grantsBeyondOwner` together with `sensitivePathName`, so a non-sensitive grant stays silent. Husky's `.husky/<hook>` writes join `.git/hooks/` in `installsPersistence` under a closed hook-name list.
- **0010 — the conditions any wiring must meet** (accepted). One core with two evidence adapters, authorized as one scope with one rollback; a decision change moves the cache version; a claims `reason` crosses the same redaction boundary as the live lane; the missing facts are closed before wiring; adoption is gated by a freshly frozen set, and ideal-label alignment is a design check only.
- **0011 — an unreadable authentication header is a sending shape, not a credential** (accepted). A `curl`/`wget` `Authorization`, `Proxy-Authorization`, or `X-Api-Key` value that is an expansion escalates to ask-side rather than joining the credential disjunction, so a named request still asks and no hard deny follows. Ordinary dynamic headers, single-quoted (inert) values, and `Cookie` stay out. The design corpus drops `211/212 → 210/212` with `unsafe-allow 0`: the new mismatch is the accepted over-ask.
- **0012 — the mode ladder is three built-in rungs plus a custom row** (accepted). `lenient` is removed, `permissive` is renamed `auto` with identical cuts, and `mode: "custom"` runs the operator-defined `customMode` pair (`allowThrough`, `denyFrom`, `onReviewFailure: deny|defer`) — two boundaries, so contiguous by construction. An unconfigured `custom` repairs to `default` with a config issue; a configured one joins the picker and the cycle last, and renders red exactly when it never asks.

- **0013 — a reviewer allow cannot lift a proven irreversible effect** (accepted). The leniency ladder maps only what the reviewer emits, so an allow reached the agent untouched — a live anchored round caught three cases where a naming anchor was read as authorization for a history rewrite or a recursive delete outside the project. The deterministic floor now raises such an allow to an ask in every mode, on both the fresh and cache-hit path, reusing the existing mapping and record shapes: no second decision table. Coverage is a closed fact list (history rewrite, recursive delete outside the working directory, persistence install, all-interfaces listener, credential-shaped data to a sender, raw block copy (`dd`)); scratch paths, single-file deletes, named build outputs and `git stash` stay allow. On the classifier lane the floor is inert for every anchored corpus case measured so far (20 cases fire it; the decision table allows none), and it would ask exactly as here if a classifier allow ever met these facts.

## Binding constraints from external review

- Deterministic upstream deny rules must land and be proven to intercept before the model's deny is demoted to an ask signal. Demoting first is forbidden because explicit-danger commands would temporarily degrade to ask. 0006 satisfies it.
- Write and test the invariant "model output must not alone produce hard deny". Treat provisional experiment states as experiments, not as the base for long-term mechanisms.

## Prohibited shortcuts

- Never zero an `unsafe-allow` by re-labeling. A defer whose action genuinely returns cloud temporary credentials is factually correct; "fixing" it by re-labeling would hide a real release.
- A `target=system_or_service` read lands on `restricted-read`: guard that a trusted `requested` releases. The metadata case is accepted behavior by user decision; query-shape variants do not constitute a distinguishing signal.
- A routine command is a run, not a release proof. A recognized build/test/lint name — even with a declared body — leaves the target, the config, and the test files unread, so the shared core rates it `unproven` and its completeness contract names `workspace_modification`, which still cannot release an `unproven` base. The running table still normalizes it to a modification (part of the measured divergences), and that difference must not be mistaken for a lane contract the core failed to honor.
- Attribution only localizes risk; it never proves post-removal model behavior, so there is no blanket "one lane is primary" contract.
- Expectation-vs-blind mismatches where the model stayed stricter than the amended record are not policy defects: a request's guard row releases on a named anchor with no escalating fact, and the model's stricter reading agrees with the original independent judgment.
- The design set derives expectations from impact records — what the command would actually do — never from the rule set or a model reading, so the rule set cannot certify itself.

## Measured results

- **Design corpus, paper: 210/212, unsafe 0.** One miss is a reverse shell over bash, a frozen screen gap; the other is the header tightening's deliberate over-ask (`Authorization: Bearer $VAR` defers even with a named request — the authorized ask-side cost of ①).
- **Alignment, 212 cases, ideal labels: 186/212 agree, 26 intended `unproven` movements, 0 other.** Design check only: it compares the shared core to the running table, not a model.

## Frozen items and contamination

- `confidenceThreshold` stays 0.5 — **uncalibrated**. Do not move it without a calibration study on fresh data; confidence gates positive readings only and never licenses a release.
- **Two kinds of set, two different answers.** A validation set judges command coverage against an expectation written before the run, and only it can carry a validation claim. A diagnostic set shows what the lane cannot express; it says nothing about adoption or novelty. The 212-case design corpus is neither: it drove the table's design, so it can show agreement and nothing more.
- **A measured number means nothing without its set and status.** `210/212` is ideal-label replay of the current table; `186/212` is the same labels run through the shared core. Neither is a live run, and neither is an acceptance test.
- A set touched after it is frozen is contaminated and never reused: a clean adoption round needs a set frozen before the change it measures. A behavior change needs its own authorization and a pre-registration; a failed round is a finding, not a retry.
- Wording changes are subtractive only: remove redundancy and ambiguity, never add tool-name exceptions, exclusion clauses, or new categories. Deterministic interception belongs in the policy engine, never in the prompt.
