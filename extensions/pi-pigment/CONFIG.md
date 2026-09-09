# pi-pigment Configuration

Good news first: you probably don't need this file. pi-pigment ships **65 converted themes** (the whole Shiki bundle) registered under the `pigment-` prefix — pick one in pi's theme selector (`/settings` → Theme, or `"theme"` in pi's settings.json) and the **entire pi follows**: chrome, tool boxes, and the diff renderer (which maps the selection back to the original Shiki theme for full-precision syntax colors). With no configuration at all, everything derives from your active pi theme — a `pigment-*` theme gets the precise pipeline, any other theme gets its own `syntax*` colors (WCAG-adjusted for the diff backgrounds). If the defaults look right, you're done.

If you do want to bend things, the whole surface is one file, read from two layers:

| Layer   | Path                                            |
| ------- | ----------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pigment/config.jsonc`   |
| Project | `<project>/.pi/extensions/pigment/config.jsonc` |

Both layers are JSONC (comments and trailing commas allowed); `config.json` is accepted as a fallback filename. The **project layer overrides the global layer** (deep-merged: nested objects merge, arrays and scalars replace). The global path honors `PI_CODING_AGENT_DIR` (it uses pi's own agent-directory resolution).

There is nothing else to configure — no environment variables, no pi `settings.json` keys. See [ADR 0001](./docs/adr/0001-configuration-redesign.md) for why the surface is this small.

## Options

```jsonc
{
  // Tools pi-pigment does NOT register; Pi's built-in tool is used instead.
  // Valid values: "write", "edit", "bash", "grep", "find", "ls", "powershell".
  "disabledTools": [],

  // Left-edge change indicator in diff views.
  // "bar" — the ▌ marker on changed lines.
  // "none" — no marker.
  "indicatorStyle": "bar",

  // Syntax TOKEN override (ADR 0006). "auto" (default) follows the active
  // pi theme: pigment-* themes map to their Shiki sources (full tokenColors
  // precision); other themes derive from their syntax* colors. An explicit
  // value overrides ONLY the token colors — chrome, canvas, and diff roots
  // always belong to the pi theme. Values follow pi's theme grammar: a
  // single theme name ("vitesse-dark", "my-theme") or an explicit
  // "light/dark" pair ("github-light/github-dark"). See below.
  "syntaxTheme": "auto",
}
```

### The syntaxTheme object

The object form has two modes:

**Patch mode** (`base` given) overlays your colors on any base — a diff-only override must still name it: `{"base": "auto", "diff": {...}}` (an object with only a `diff` key is rejected, with an issue pointing at the fix). Patches apply over — `"auto"` (the default derived theme), a theme name (Shiki-bundled or a `themes/` file), or a `"light/dark"` pair:

```jsonc
{
  "syntaxTheme": {
    "base": "catppuccin-latte/catppuccin-mocha",
    "colors": { "keyword": "#ff7b72", "string": "#a5d6ff" },
    "diff": { "added": { "text": "#3fb950" } },
    "dark": { "diff": { "removed": { "tint": "#5c1d1dcc" } } },
  },
}
```

**Variant mode** (no `base`) defines a brand-new theme from per-polarity variants — each variant's `colors` is a complete semantic palette. A top-level `colors` object merges under the per-polarity variant (the variant wins per key), the same key-merge the `diff` roots use:

```jsonc
{
  "syntaxTheme": {
    "dark": { "colors": { "keyword": "#bb9af7", "string": "#9ece6a" /* … */ } },
    "light": { "colors": { "keyword": "#74489f", "string": "#387a1b" /* … */ } },
  },
}
```

**Variant bases** — each variant may also name its own `base` (`"auto"`, a theme name, or a `"light/dark"` pair), pairing user theme files per polarity; the variant's `colors` patch over it:

```jsonc
{
  "syntaxTheme": {
    "light": { "base": "my-theme-light" }, // themes/my-theme-light.json
    "dark": { "base": "my-theme-dark", "colors": { "keyword": "#ff00ff" } },
  },
}
```

**File pairs** — the same slash grammar pairs user files: `"my-theme-light/my-theme-dark"` (each half a `themes/` stem). A pair with only one usable half renders that half on its polarity; the missing polarity falls back to `auto`.

Theme files are keyed by FILENAME (the JSON's `name` is a display label). Any theme in [Shiki's bundled gallery](https://shiki.style/themes) drops in as-is — the JSON lives in the [tm-themes](https://www.npmjs.com/package/tm-themes) package, so a one-liner installs one:

```bash
mkdir -p ~/.pi/agent/extensions/pigment/themes && \
curl -o ~/.pi/agent/extensions/pigment/themes/andromeeda.json \
  https://cdn.jsdelivr.net/npm/tm-themes@latest/themes/andromeeda.json
```

Then `/pigment convert andromeeda` registers it as `pigment-andromeeda` (after `/reload`); before converting, it stays available as the `"andromeeda"` token override.

Three shapes are accepted: VS Code JSON (`type` + `tokenColors`, the tm-themes redistribution form), TextMate JSON (a `settings` array — the global entry provides the background/foreground, and the light/dark polarity is inferred from the background's luminance), and the original `.tmTheme` XML plist (parsed natively).

The nine semantic `colors` keys: `comment`, `keyword`, `function`, `variable`, `string`, `number`, `type`, `operator`, `punctuation`. The `diff` roots are line-scoped sides only (ADR 0003, revised by 0006): `added`/`removed` (pi's toolDiffAdded/toolDiffRemoved vocabulary) hold `text` (the line text color, opaque `#rrggbb` — CSS shorthand `#rgb` expands) and `tint` (`#rrggbbaa` — shorthand `#rgba` expands; it anchors the word-level emphasis and scales the line/gutter ladder). Roots replace the derivation inputs, so the blend family (line/emphasis/gutter backgrounds) stays consistent; `light`/`dark` variants override the shared values for that polarity. The box canvas is not a root — the tool frame's three backgrounds (`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`) are the pi theme's own slots (see Canvas above).

**Enforcement boundary**: colors pi-pigment supplies (the auto-derived theme, Shiki-bundled names) are WCAG-AA-adjusted against the effective backgrounds; colors YOU set (object colors, theme files, diff roots) render verbatim. An invalid syntaxTheme falls back to `"auto"` alone — other config keys still apply.

Objects deep-merge across the two config layers (global `colors` + project `colors` combine).

### Explicit selections: names and pairs

`syntaxTheme` follows pi's theme-setting grammar. A single name is one fixed theme; a slash pair follows the pi theme's polarity (and the terminal, when the pi theme is itself an automatic pair):

```jsonc
{ "syntaxTheme": "vitesse-dark" }                    // one Shiki theme, polarity-gated
{ "syntaxTheme": "my-theme" }                        // one themes/ file
{ "syntaxTheme": "github-light/github-dark" }        // light half / dark half
{ "syntaxTheme": "my-theme-light/my-theme-dark" }    // user files pair the same way
```

**Names** — every theme in [Shiki's bundle](https://shiki.style/themes) is selectable by its own name (`"vitesse-dark"`, `"catppuccin-frappe"`, `"github-dark-dimmed"`, …), and `themes/` file stems resolve the same way; halves may mix channels (`"github-light/my-theme-dark"` is legal — each half resolves independently). A name's `type` gates polarity: a light theme on a dark pi theme falls back to `auto`, so the syntax theme's lightness never diverges from the canvas. A half whose type contradicts its position (`"github-dark/github-light"`) gets an issue instead of silently never rendering.

**AA boundary** — Shiki-bundled names are WCAG-AA-fitted to the effective backgrounds (the same enforcement `auto`'s precise pipeline applies — a theme renders identically whether reached through `auto` or by its explicit name; its colors were authored for its own background, not yours). Colors YOU set render verbatim: your `themes/` files, object `colors`, and `diff` roots. The registered `pigment-*` form follows the same split: the BUNDLED ships' nine colors are AA-protected at generation time, while YOUR converted themes take the AA sweep off — the author's colors land in the output verbatim.

**Canvas**: the tool frame's background is the pi theme's own, per call state — `toolPendingBg` while streaming, `toolSuccessBg` on success, `toolErrorBg` on error. For a `pigment-*` theme the converter wrote all three at generation time: `toolPendingBg` is the original theme's `editor.background` verbatim; the success/error slots blend the state green/red into that canvas at a polarity-gated ratio (25% on light canvases, 10% on dark). The canvas is not configurable: if it doesn't work for you, pick another theme (`/settings` → Theme) — that's the whole point of the theme provider.

The `auto` default goes further still: a `pigment-*` pi theme maps back to its original Shiki source (full `tokenColors` precision) — bundled sources AA-fitted at render time, YOUR converted sources verbatim — and any other pi theme — including custom ones — derives from its own `syntax*` colors, WCAG-adjusted for the diff backgrounds. A user source deleted after registration degrades to that derived path (the registered theme's nine baked `syntax*` colors) — degraded, never broken. See [ADR 0001](./docs/adr/0001-configuration-redesign.md).

**Recommended pairs** — the former built-in families' curation, as plain reference (these are ordinary explicit pairs now):

| Pair (light/dark)                          | Notes                        |
| ------------------------------------------ | ---------------------------- |
| `github-light/github-dark`                 |                              |
| `catppuccin-latte/catppuccin-mocha`        | latte/mocha, not frappe      |
| `one-light/one-dark-pro`                   | pro, not one-dark            |
| `gruvbox-light-medium/gruvbox-dark-medium` |                              |
| `solarized-light/solarized-dark`           |                              |
| `rose-pine-dawn/rose-pine`                 | bare `rose-pine` is the dark |
| `everforest-light/everforest-dark`         |                              |
| `kanagawa-lotus/kanagawa-wave`             |                              |
| `ayu-light/ayu-dark`                       |                              |
| `vitesse-light/vitesse-dark`               |                              |
| `min-light/min-dark`                       |                              |
| `night-owl-light/night-owl`                | bare `night-owl` is the dark |

Single-polarity classics (`nord`, `dracula`, `monokai`, `tokyo-night`) have no light half — reference them by their direct name: the theme renders on its own polarity and defers to `auto` on the other.

A Shiki-bundled name shadows a same-named `themes/` file with a warning (the built-in precedence rule). The `diffEditor.*TextBackground` keys ride the file channel (see below).

Custom theme files resolve by name after bundled names. Beyond the bundle, hand-written themes drop in as files — next section.

### Custom theme files

Drop TextMate theme files into a `themes/` directory — global `~/.pi/agent/extensions/pigment/themes/` or project `.pi/extensions/pigment/themes/` (same-named project files shadow global ones) — then convert on demand:

```
/pigment                     # TUI selector of subcommands (currently: convert)
/pigment convert             # TUI selector over the unconverted sources (project/global-tagged)
/pigment convert my-theme    # convert one directly (tab completion lists stems)
```

The command writes the converted `pigment-<name>.json` **next to its source** (visible, inspectable — open it to see your colors, verbatim: the user channel converts with the AA sweep off) and reports `/reload to register`. The picker tags each candidate with its config layer (`stem (project)`, `stem (global)`). After the reload the theme appears in `/settings` → Theme like any other.

**Conversion never retires the source**: `pigment-<name>.json` registers a pi theme for `/theme`; the source `<name>.json` keeps working as the token override (`"syntaxTheme": "<name>"` — full `tokenColors`, verbatim) for as long as it exists. Referencing the PRODUCT by name (`"pigment-<name>"`) gets an issue pointing at the right channel — it is a pi-theme JSON, not a Shiki theme. Delete the SOURCE and the output stands alone (a self-sufficient pi theme; the precise token pipeline degrades to its nine baked colors). Re-run the command after editing a source to refresh its output.

Before conversion, a source remains selectable as a token override by file name:

```jsonc
{ "syntaxTheme": "my-theme" }
```

Three forms are accepted. VS Code JSON carries `"type": "light"` or `"dark"` (mismatched polarity falls back to auto) and a `tokenColors` array. TextMate JSON carries a `settings` array instead — the global entry's background provides the polarity (inferred from its luminance) and the default foreground, no `type` needed. The original .tmTheme XML plist is accepted as-is (parsed natively by pi-pigment; a file renamed away from `.tmTheme` parses as whatever its extension says and fails loudly; matching is case-sensitive — the canonical spelling is `.tmTheme`). An optional `"diff"` extension key carries root overrides (other Shiki consumers ignore it, so any real Shiki theme still works as-is):

```jsonc
{
  "type": "dark",
  "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#bb9af7" } }],
  "diff": { "background": "#16161e", "added": { "tint": "#9ece6a33", "text": "#9ece6a" } },
}
```

**Diff colors in the registered form**: the file's `diff` key rides the converter — `added`/`removed` `text` roots fill the `toolDiff*` slots (AA-enforced; the canvas stays the theme's own `editor.background`). The `diffEditor.*TextBackground` tints color the same slots (the tint's hue lands through the text/token extraction); the pi theme format carries no alpha vocabulary, so the emphasis ladder uses the standard ratios — your exact alphas remain available through the config `diff` roots (the runtime override). All other VS Code diff keys (`insertedLineBackground`, `editorGutter.*`, borders, moves) are ignored — the blend family stays derived.

As a token override (`"syntaxTheme": "my-theme"`), the file renders verbatim — no WCAG adjustment (the authenticity channel: for the exact original look of a theme, including its native low-contrast choices). JSONC (comments, trailing commas) is accepted; both `.json` and `.jsonc` extensions resolve.

## Recipes

Just the diff colors — everything else stays derived (the canvas is always the pi theme's own):

```jsonc
{
  "syntaxTheme": {
    "base": "auto",
    "diff": { "added": { "tint": "#3fb95066" } },
  },
}
```

Catppuccin syntax tokens over your pi theme (for the full look, pick `pigment-catppuccin-latte`/`-mocha` in the theme selector instead):

```jsonc
{
  "syntaxTheme": "catppuccin",
}
```

Disable the write wrapper (keep the edit diff view):

```jsonc
{
  "disabledTools": ["write"],
}
```

A quieter marker:

```jsonc
{
  "indicatorStyle": "none",
}
```

## Failure behavior

Failures are scoped, never fatal. A malformed file skips its own layer (the other layer still applies); an invalid value after the merge falls back per key — a bad `syntaxTheme` alone becomes `"auto"` (the other keys survive), a bad `disabledTools`/`indicatorStyle` falls the whole merged config back to the schema defaults. Warnings surface in the TUI notification area, or stderr in headless modes, re-fired on every session_start. With no valid configuration at all, the defaults above stand — a config error never disables the renderer.
