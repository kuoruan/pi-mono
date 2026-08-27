# The hard-deny floor is carried by the reviewer's risk labels; operator deny-rules are the specified retreat path

The ladder's invariant — a terminal deny for `riskLevel` high|critical (or missing) in every mode, permissive included — is carried by the reviewer model's self-reported risk labels, not by operator-authored deny rules. Weighed three carriers and picked the model-label floor; the operator-rules alternative stays fully specified below as a targeted migration if a reproducible high/critical mislabel incident ever arrives.

## Considered Options

- **A. Model-label floor (chosen).** The hard tier is the one judgment no mode loosens; permissive keeps meaning ("only clear high-danger requests are blocked"). Zero-config floor; reversible via the retreat path.
- **B. Operator deny-rules floor (retreat path).** `riskLevel` becomes display-only; terminality moves to an operator-authored deny-rules surface (the Claude Code shape: deny rules block in every mode, bypass included). Rejected now for three reasons: it builds a feature nobody has asked for, to solve a calibration failure that has not occurred; its determinism payoff only matters once calibration is actually failing; it turns the reviewer fully advisory exactly in the mode where the operator most needs a floor that is not their own attention.
- **C. Critical-only floor.** Narrows the floor band to `critical`, `high` joins the soft lane. Rejected: weakens permissive's promise, with no mislabel evidence to motivate the narrowing.

## Consequences

- Floor quality equals the reviewer's high/critical calibration quality; audit it via advisory-mode dialogs and the decision log.
- `permissive`'s hard deny now notifies a warning at the human — the mode's one intent-contradicting block names itself, like every other interruption with no user-visible agent action.
- Revisiting this decision is a targeted migration to B, never a from-scratch redesign.
