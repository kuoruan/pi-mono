# 0002 — Custom syntax themes and color overrides

pi-pigment grows a user-controlled theme surface: TextMate theme files (JSON and the original .tmTheme plist) discovered from `themes/` directories (global and project layers), an inline `syntaxTheme` object patching a base theme with semantic syntax colors and diff root overrides, and AA enforcement for built-in themes — while user-set colors render verbatim. Supersedes ADR 0001's "no per-color overrides" clause (its two-layer JSONC + safe-fallback architecture stands).

> **Revision (ADR 0006)**: the enforcement boundary stands; the selection semantics narrowed — `syntaxTheme` selects token colors only (the chrome/canvas/diff roots belong to the pi theme). "Verbatim, on its own canvas" became "verbatim tokens, on the pi theme's canvas". This document survives as the historical record of the object form and the boundary decision.

## Enforcement boundary

Colors pi-pigment supplies (the pi-derived auto theme, Shiki-bundled names) are WCAG-AA-enforced against the **effective** renderer backgrounds; colors the user sets (custom theme files, inline `colors`, `diff` roots) render **verbatim** — explicit input is owned input.

**AA is a dynamic function of the current colors, never a static table.** The enforcement backgrounds are the effective ones: derived from the active pi theme _and_ any user diff-root overrides. Changing the pi theme (e.g. a custom `~/.pi/agent/themes/*.json`) or overriding diff roots re-derives the backgrounds and re-runs enforcement (memo keyed on theme + roots). The enforced side adapts to whatever backgrounds actually render.

The low-contrast output heuristic is retired: enforcement subsumes it on enforced paths, and verbatim semantics forbid it on user paths. The auto path's github-pair fallback is also gone: "auto" means derived from the pi theme, and an unresolvable derivation (e.g. non-truecolor pi theme values) renders unhighlighted — the honest degradation, matching the large-diff fallback. The github pair remains an explicit selection (`"github-light/github-dark"`).

## Selection & resolution

`syntaxTheme` accepts a string or an object:

- **String** (pi's theme-setting grammar): `"auto"`, a single theme name — a Shiki-bundled
  theme name or a custom theme name resolved from `themes/` directories (project
  `<cwd>/.pi/extensions/pigment/themes/`, shadowing same-named global files, then global
  `~/.pi/agent/extensions/pigment/themes/`) — or an explicit `light/dark` slash pair
  (`"github-light/github-dark"`: the first half renders on light pi themes, the second on
  dark). Bundled names take precedence over same-named files; bundled names enforce against
  the effective backgrounds (the revision above), user files render verbatim. Unresolvable →
  ConfigIssue + auto fallback.
- **Object** (theme object) resolves per the current pi polarity:
  - **Patch mode** (`base` given): start from the base's resolved theme for
    that polarity (a gated base falls back to auto — patches continue on it), then overlay top-level `colors`, then the current polarity's variant `colors`.
  - **Variant mode** (no `base`): the `light`/`dark` variants ARE the theme —
    each variant's semantic `colors` (nine keys: comment, keyword, function, variable, string, number, type, operator, punctuation) build a TextMate theme through the same scope-mapping the pi-derived theme uses, with the author's own polarity authority. A missing variant for the current polarity falls back to auto (same rule as single-polarity names). No variants at all → ConfigIssue.
  - `diff` roots merge per polarity: top-level roots apply to both, the
    current polarity's variant roots win per key. `diff` entries are valid in both modes and inside variants.

Custom theme files are theme JSON (JSONC-tolerant) with an optional `diff` extension key (ignored by other Shiki consumers, preserving compatibility). Two shapes: VS Code JSON requires `type` for polarity gating; TextMate JSON (a `settings` array) infers polarity from the global background's luminance (recorded in the Variant semantics section below).

## Diff roots, not outputs

Overrides target the derivation inputs — `added`/`removed` sides with `text`/`tint` slots in ADR 0003's shape (revised by 0006: the box canvas is not a root) — not the derived palette outputs. The blend family (line/emphasis/gutter backgrounds) stays internally consistent, and `isLight` keeps following the pi theme. Overriding only outputs would leave the derived siblings stale.

## Polarity gating

Custom theme files declare `type`; when it contradicts the pi theme's polarity the theme is not used (auto fallback) — the same rule as single-polarity names. Inline patches inherit the base's polarity handling.

**Variant semantics.** Each variant (`light`/`dark`) is shaped like the top level — `base` (a theme name or a `light/dark` pair), `colors`, `diff` — generalizing the pair structure to per-polarity user files: a light and a dark theme file pair up under one `syntaxTheme` object, and the variant's `colors` patch over its base. An explicit `base: "auto"` with variant `colors` follows variant-mode semantics (the variant's colors ARE the theme, key-merged with top-level colors) — not patch-over-auto; `base: "auto"` exists for diff-only overrides and variant-color themes. Theme files are keyed by filename (the JSON `name` is a display label); TextMate-JSON files (a `settings` array, no `type`) get their polarity inferred from the global background's luminance.
