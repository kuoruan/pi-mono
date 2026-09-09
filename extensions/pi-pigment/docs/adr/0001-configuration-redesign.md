# 0001 — Configuration, color architecture, and the pi-pigment identity

Configuration is exactly two layers of one file: global `~/.pi/agent/extensions/pigment/config.jsonc` and project `<cwd>/.pi/extensions/pigment/config.jsonc` (mirroring pi-permission-ai-guard's config-layer design: JSONC-tolerant parsing via jsonc-parser, zod validation, deep merge with project overriding global, no project trust gating — the config is cosmetic and carries no security surface). The surface is minimal by design: rendering is zero-config by default, and every surviving behavior has exactly one knob. Re-adding a knob later is additive; a dead one is a documentation lie. (The `syntaxTheme` key and theme-object form extend this stance — see ADR 0002 — without any env var or settings.json surface.) Schemas are strict: an unknown key records an issue instead of being silently stripped — a mistyped key (`disabledTool`) silently doing nothing is worse than a recorded complaint.

> **Revision (ADR 0006)**: the zero-config default grew a second limb — theme selection itself is now zero-config (the bundled `pigment-*` themes register through the package `themes/` directory; picking one in `/settings` is pi's own native flow, not pi-pigment configuration). `syntaxTheme` narrowed to the token override layer. The surface stays three keys.
>
> **Revision (value grammar)**: `syntaxTheme` string values now follow pi's own theme-setting grammar — a single theme name or an explicit `"light/dark"` slash pair. The curated family shorthand (`"github"` → its halves) and the implicit `-light/-dark` file-pair discovery were removed in favor of the explicit pair (`"github-light/github-dark"`); the families' curation survives as a recommended-pairs table in CONFIG.md. The AA boundary unified: Shiki-bundled names enforce (matching `auto`'s precise pipeline), user files render verbatim. Conversion no longer retires a source from the token channel.

## The rendering color contract

All rendering colors derive from the active pi theme, never from ambient terminal detection:

- **The diff palette** auto-derives by blending the theme's `toolDiffAdded`/
  `toolDiffRemoved` foregrounds into `toolSuccessBg`/`toolErrorBg`. The only override path is ADR 0002's diff roots.
- **The "auto" syntax theme** builds a TextMate theme from the pi theme's own
  nine `syntax*` colors (required in pi's theme schema). An unresolvable derivation (e.g. 256-color pi theme values that decode to no RGB) renders unhighlighted — honest degradation, matching the large-diff fallback. There is no substitute fallback theme; the github pair is just one of the curated families.
- **Syntax-theme lightness always follows the pi theme's polarity** — the
  invariant every selection form in ADR 0002 preserves.

**Escape construction** goes through a forced-truecolor ansis instance (`new Ansis(3)`): the renderers' escapes are the final rendering contract and must NOT adapt to `NO_COLOR`/`FORCE_COLOR`/non-TTY detection (the pi TUI owns color-level degradation). `parseAnsiRgb` (escape → RGB, truecolor and XTerm-256) stays hand-rolled because no color library provides that direction, and pi themes hand us escapes.

**WCAG AA enforcement.** Colors pi-pigment chooses are checked against the effective renderer backgrounds (the four blend surfaces), and failing colors walk HSL lightness toward the palette-safe extreme — hue preserved, compliant colors untouched. The enforcement is a dynamic function of the current pi theme (and any diff-root overrides), memoized on those inputs, never a static table. See ADR 0002 for the enforcement boundary between our colors and user-set colors.

**Language detection** for file paths goes through the SDK's own `getLanguageFromPath` first (the authority — it knows the C-header and makefile spellings), falling back to Shiki's language keys (ids + the alias registry the community keeps populated with newer extensions), then the two header spellings neither carries.

**Color math** goes through @ctrl/tinycolor (chosen over colord — which rounds luminance to two decimals, unusable for AA enforcement; colorjs.io — W3C's reference but 17 MB and slowest; culori — no bundled types and a 154-file module graph pi's jiti loader pays in full). ansis owns escape construction; tinycolor owns conversion, blending, luminance, and contrast.

**Syntax-color output** renders through our own token→ANSI path (forced truecolor, fontStyle bit-tested per vscode-textmate's Italic=1/Bold=2/ Underline=4/Strikethrough=8). The earlier `@shikijs/cli` wrapper routed through ansis' AMBIENT instance, which collapsed under `NO_COLOR` while the palette stayed truecolor — a broken half-colored output that violated the contract above; both halves now share the forced-truecolor rendering.

## The name

The name **`pi-pigment`**: pigment — the "pi" that starts the word — is the color material this extension works in. Every color derives from the active pi theme, so the rendering adapts to whatever palette you mix; the name says the extension is pi's own pigment (the renderer covers all tool output, not only diffs).
