# 3. Lean-routed defer sub-lanes and the four-mode ladder

Date: 2026-08-26

## Status

Accepted

## Context

In live use, `defer` is a substantial share of all verdicts — enough that `default` mode's
ask-on-every-defer behavior dominates the operator's interruption volume. Sampling the defer
reasons shows the defer bucket collapses two distinct subpopulations:

- "the action is visible-and-benign, only the authorization link is unclear" (reads of
  research files outside CWD, curl fetches) — the reviewer completed the danger screen and
  found nothing; the only open question (intent matching) is one the model structurally
  cannot see. This is the majority subpopulation.
- "what is visible resembles a danger pattern, confirmation missing" (remote content
  piped to an interpreter, router mutations).

`default` asks on the whole bucket uniformly. The benign slice's dialogs are rubber stamps —
the operator confirms the reviewer's own inclination, paying full interruption cost for near
zero decision value.

Separately, `lenient` auto-passes ALL defers — including the danger-leaning slice — which
contradicts its own contract ("only the reviewer's active alarms ask you": a deny-leaning
defer IS an active alarm).

## Decision

The reviewer's defer output carries an optional `lean` field — its directional inclination
("if forced to pick now, I'd allow/deny"; omitted = genuinely neutral; invalid values
degrade to neutral, never invalidating the defer). The prompt anchors both directions:
`lean: deny` when what is visible resembles a danger pattern; `lean: allow` when the action
is visible-and-benign and only the authorization link is unclear.

The mode ladder is four rungs — `strict`, `default`, `lenient`, `permissive` — disposing
verdicts by **suspicion order** (allow < defer+lean:allow < defer neutral < defer+lean:deny
< soft deny < hard deny). Each mode is two cut lines on that order (the classic
reject-option double-threshold operator: auto-accept / human review / auto-reject). The
ladder's identity: `default` asks on every flag short of hard danger (the resting mode and
the onboarding posture — watch the reviewer work, then loosen); `lenient` passes the
reviewer's benign and neutral doubts; `permissive` passes everything short of hard denies.
The ask sets nest strictly (`default` ⊃ `lenient` ⊃ `permissive` asks nothing), and the
ctrl+alt+g cycle visits `default → lenient → permissive` with `permissive`'s red footer as
the guardrail; only `strict` is set explicitly. The full matrix:

| Verdict ↓ (suspicion ↑) | strict | default | lenient | permissive |
| ----------------------- | ------ | ------- | ------- | ---------- |
| allow                   | allow  | allow   | allow   | allow      |
| defer + lean:allow      | deny   | ask     | allow   | allow      |
| defer (neutral)         | deny   | ask     | allow   | allow      |
| defer + lean:deny       | deny   | ask     | ask     | allow      |
| deny (soft)             | deny   | ask     | ask     | allow      |
| deny (hard)             | deny   | deny    | deny    | deny       |

Structural invariants:

- **Lean moves a defer across only the ask↔allow boundary, in its own direction.** Below
  strict, the deny band is reachable only by decisive (hard-tier) denies; lean never
  produces a deny. `strict` and `permissive` are lean-inert — their contracts are absolute.
- **An unresolved verdict always keeps an ask path somewhere in the ladder.** `default` asks
  on every defer, any lean. The only never-ask kinds are decisive verdicts (`allow`, hard
  deny). Rationale: the lean:allow subpopulation's defining open question is the
  authorization link — invisible to the model by construction. An injection-driven
  mismatch is a benign-looking action outside the user's intent: no visible danger pattern
  exists for the model to double-error on, so the auto-pass's safety margin does not cover
  it — only the ask does. `default` (the resting mode) keeps that check; the auto-pass is
  `lenient`'s deliberate, operator-chosen delegation of it.
- **Band contiguity**: every mode's three bands are contiguous in suspicion order. Pinned by
  a parameterized test; a future lane edit that fragments a band fails it.
- **Lean never surfaces to the human.** Dialogs and notify lines carry the clarification
  question, not the lean — the ask is the operator's judgment moment, and "Learning to
  Defer" research (Mozannar & Sontag 2020 et al.) shows a displayed model inclination anchors
  the human's decision even when labeled low-confidence. The lean lives in the audit record
  (`lean: "allow" | "deny" | null`) for post-hoc diagnosis.

Facts that follow from the matrix:

- The breaker counts the model's verdict — a defer feeds no tier, whatever the lean or the
  emitted verdict.
- Defers are never stored in the verdict cache, lean-derived allows included; an identical
  ask re-reviews fresh each time.
- `AuthorizerVerdict`'s allow/deny/defer is the host's enum; lean is this extension's field
  in the model output format only and never flows upstream.

## Consequences

- `lenient` auto-passes benign- and neutral-leaned defers — the ladder's one fail-open
  path, a deliberate rung rather than a resting-mode default (`default` asks).
  **It runs without a sandbox**: unlike Codex full-auto (whose blast radius is
  absorbed by network/filesystem isolation), a wrongly-leaned allow executes on the host
  directly. Post-hoc visibility is the audit record alone — no notify fires (a benign-
  leaned pass is the model's own inclination confirmed, not the mode overriding an explicit
  verdict; the one-time fail-open notice belongs to swallowed DENIES and auto-passed
  NEUTRAL uncertainty only). This is an accepted risk, stated — not an oversight.
- The risk bound is the reviewer's ACCURACY on the benign slice, not its calibration (the
  literature's warning: safe automation is bounded by classification accuracy). For
  VISIBLE danger, reaching the auto-pass cell requires a compounded double error — the
  model must both miss the danger pattern AND lean allow — two error-orders more
  conservative than `permissive`'s soft-deny swallow (zero model errors).
  For INTENT mismatches (injection-driven, nothing visible to miss), the model errs not at
  all — which is exactly why `default` keeps the ask; `lenient` has delegated the intent
  check by choice.
- `lenient` asks on deny-leaned defers (an active alarm) and soft denies — its blurb is
  literal. The default↔lenient difference spans the defer rows (benign/neutral: ask vs
  pass) — the lean field is exactly what separates "ask me everything unresolved" from
  "the reviewer's benign inclination suffices".
- `permissive` passes deny-leaned defers along with everything else short of hard denies —
  the audit's `lean` field says which way the reviewer leaned on each pass
  (diagnosability), it does not widen the mode's exposure.
- The lean parse is tolerant (invalid → neutral); if a model never emits lean, every defer
  routes as neutral — the ladder degrades gracefully to lean-free behavior.
