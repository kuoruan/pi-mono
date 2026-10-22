# ADR 0013: The Deterministic Floor — a Reviewer Allow Cannot Lift a Proven Irreversible Effect

Date: 2026-10-22
Status: accepted

## Context

The leniency ladder maps only what the reviewer emits: `applyVerdictMode`
returns an allow untouched, in every mode. A live anchored round (52 corpus
cases with transcribed anchors, chat lane) caught three cases where the model
read a naming anchor as authorization and allowed an action the deterministic
facts already prove unrecoverable — `git restore --source=HEAD`, `git checkout
--`, and `rm -rf` outside the working directory. The classifier lane deferred
on all three identical inputs. The allow reached the agent with no ask and no
record of the doubt.

## Decision

A reviewer allow that meets a fact proving an irreversible effect is raised to
an ask before emission — in every mode, on both the fresh and the cache-hit
path (the cache stores the reviewer's verdict, not the link's, so a cached
allow crosses the same floor). The floor:

- never denies and never lowers a stricter verdict;
- speaks through the one release ritual the other gates use, so the ask, the
  record annotation, and the notice keep a single shape — no second decision
  table and no second mapping;
- covers a closed fact list, each entry backed by a signed escalator rule or a
  `needs_human` impact case: a history rewrite, a recursive delete outside the
  working directory, a persistence install, an all-interfaces listener,
  credential-shaped data handed to a sending command, a raw block copy (`dd`).

Deliberate non-coverage, each pinned by a regression row that must stay allow:
a scratch path (`/tmp/...`), a non-recursive single file, a named build
output, `git stash`, and non-bash surfaces. A false positive costs one
confirmation; a false negative costs an irrecoverable action with no record.

The floor fires on the reviewer's own allow only: a defer the mode maps to an
allow is the mode's explicit leniency, not a reviewer judgment, and is left
alone.

## Consequences

- An anchored request to delete a named tree outside the project, or to revert
  a file to HEAD, now asks even when the reviewer allows. This is the escalator
  policy (`requested && !escalated → allow`) enforced deterministically rather
  than by reviewer judgment.
- The ask carries the floor's own reason, naming what each fact proves (a
  history rewrite destroys work no revision holds; a persistence install
  outlives the session). It never reuses the mapping's "reviewer denied" line,
  which would misreport an allow as a denial, and it never fires the allow-side
  approval notice.
- The record keeps the review's identity — `model` for a fresh verdict,
  `cache-hit` for a replay — and adds `floorFacts` plus the emitted ask, so the
  extra confirmation is auditable without claiming a second review happened.
- On the classifier lane the floor is inert for the 20 anchored corpus cases
  whose facts fire it — the decision table allows none of them, verified
  offline against the current implementation rather than inferred from earlier
  paid rounds. It is a second net, not a redundant one: `rawCopy` is true for
  any `dd`, and the table releases an unescalated `guard` row on a trusted
  anchor, so a classifier allow on an anchored file-to-file `dd` would now ask.
  The corpus has no `dd` case, so that direction is unmeasured — the direction
  is safe (an extra ask), but it is a behavior change, not a no-op.
- Deliberate boundary: an unscoped recursive delete (`rm -rf "$VAR"`, scope
  `unknown`) does not fire the floor, because the floor acts only on proven
  facts. The classifier lane asks on it through `block`; a chat-lane allow on
  an unratable recursive delete still passes, unchanged by this decision.
