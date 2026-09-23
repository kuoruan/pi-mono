# ADR 0007: Took-footer state colors

## Status

Accepted

## Context

pi-pigment renders `Took Xs` footers in two places: the collapsed grep/find/ls tail (via `collapsedView`) and the error frame's footer (via `formatToolErrorResult`). Both read the same render-state execution clock, and both painted the footer in the theme's `muted` color regardless of how the call ended — a successful tail, a failed frame's footer, and the pending-state's absence all read identically at a glance, while the rest of the frame (backgrounds, badges, bar column) already encodes the call's state.

## Decision

The footer color becomes the call's STATE, expressed as `tookFooter(ms, theme, color)` with a required color — `"muted" | "success" | "error" | "warning"`:

- **The collapsed tail hardcodes `"success"`**: the factory's renderResult error branch returns before `spec.renderResult` runs, and a pending frame measures no duration — a tail footer exists if and only if the call settled successfully.
- **The error frame colors by its `barKind`** — the badge's failure kind for shell frames (plain exits error, the code-less kinds warn), plain error for non-shell frames. `ErrorFrameInput` carries `tookMs?: number`; `formatToolErrorResult` composes and colors the footer itself, beside the bar glyph that already uses the same kind.
- **The factory passes `tookMs` and stamps `tookMs ?? -1`** in the preview identity: stamps cover every input the render closure captures; the `-1` sentinel keeps unmeasured distinguishable from a measured 0ms.
- **Pending and replayed rows render no footer at all** — never a muted one; resumed rows' clocks were never armed (ADR 0005's output-delegation boundary: bash/powershell's native Elapsed/Took stay untouched).

`"muted"` keeps no production caller; it stays in the union as the reserved slot for coloring a native Elapsed footer should one ever be painted.

## Scope of the change

Text color only — geometry untouched (same body, same `\n\n` framing, same `·`-joined tail). No layout, no budgets, no `THEME_FG_KEYS` extension.

## Rollback

A single-commit revert restores the muted-only footer; no data, config, or session format participates.

## Residual risks

A theme hot-reload changing ONLY `warning` leaves `palette.identity` unchanged, so rendered error frames keep their footer color until the next re-arm (theme switch, reload, expand toggle). Extending `THEME_FG_KEYS` for a footer-only cosmetic was rejected.
