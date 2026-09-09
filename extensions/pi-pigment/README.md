# pi-pigment

**Pigment for your pi.**

pi-pigment repaints what pi prints. Diffs get word-level change emphasis, shell commands render in their own grammar, grep hits are highlighted in the hit file's language, and file listings color each entry by type. Every color comes from the pi theme you're already wearing, so the rendering follows whatever palette you run. Nothing to configure by default; three keys if you want to bend it.

## What it renders

| Tool         | Rendering                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `write`      | Diff with word-level change emphasis — split when balanced and the terminal is wide, unified (stacked) otherwise; new files render as a syntax-highlighted preview |
| `edit`       | Split (side-by-side) diff, auto-falling back to unified on narrow terminals or wrap-heavy hunks                                                                    |
| `bash`       | The command itself renders in shell grammar (strings, flags, operators); the output keeps pi's native display — timing, preview windows, truncation footers        |
| `grep`       | Hit lines highlighted in the hit file's language with the matched pattern emphasized; `file:line:` prefixes stay muted                                             |
| `ls`         | Entries colored by type (directories accent + bold, code files tinted) in a tree listing with `├──`/`└──` connectors                                               |
| `find`       | Result paths colored by type: dim directory prefix, type-colored basename (accent dirs, tinted code files, warning-tinted limit notices)                           |
| `powershell` | The Windows shell twin: command colored in PowerShell grammar with the `PS>` prompt; output keeps pi's native display (Windows-only execution)                     |

Details worth knowing:

- **Word-level emphasis** — changed characters inside paired add/del lines get brighter backgrounds, so a one-word tweak never hides in the line
- **Grammar accuracy** — Shiki with its full bundled language set (340+ grammars, detection via Shiki's alias registry)
- **Embedded code injection** — bash commands parse via a shell AST (@aliou/sh):
  - heredoc bodies render in their interpreter's grammar (`python3 << EOF`)
  - heredoc file-writes in the target's (`cat > app.py << EOF`)
  - inline code args too (`python -c '...'`, `node -e '...'`)
    parse failures degrade gracefully
- **Zero-config palette** — diff backgrounds blend the theme's `toolDiffAdded`/`toolDiffRemoved` foregrounds into its `toolSuccessBg`/`toolErrorBg`; the syntax theme follows the detection chain:
  - a `pigment-*` theme maps back to its Shiki source (full `tokenColors` precision — bundled sources AA-fitted at render time, YOUR converted sources verbatim)
  - anything else derives from its own nine `syntax*` colors, WCAG-AA-adjusted for the render backgrounds
  - an explicit `syntaxTheme` override paints tokens only; the canvas always belongs to the pi theme
- **Collapsed search output** — grep/find/ls bodies collapse past the native renderers' own budgets (15/20/20 lines) with a `ctrl+o`-to-expand tail carrying the measured execution time
- **Large-input fallback** — highlighting skips past 80,000 characters per block; the diff structure still renders
- **Strict edit safety** — execution always delegates verbatim to the SDK tools (matching, uniqueness, overlap checks, mutation queues, aborts, BOM, and EOL preservation); only the rendering is replaced

## Install

Requires pi ≥ 0.85.0 and Node ≥ 22.

```bash
pi install npm:pi-pigment
```

Restart pi and the rendering takes over — no config needed.

> **A note on one install-time warning:** `@aliou/sh` (the shell-command parser) declares `node >= 24` in its engines field, so installing on Node 22 prints an `EBADENGINE` warning. It's a false claim — the package uses no Node 24 APIs and runs fine on 22 (pi-pigment's test suite exercises the parser on the supported Node range).

## Themes

pi-pigment ships the whole Shiki bundle as **pi themes**: after install, `/settings` → Theme lists every one under the `pigment-` prefix (`pigment-solarized-light`, `pigment-github-dark`, …). Pick one and the **entire pi follows** — borders, boxes, backgrounds, and the diff renderer, which maps the selection back to the original Shiki theme for full-precision syntax colors (AA-protected on the actual canvas). The selection persists in your pi settings like any theme; pi's `"theme": "pigment-solarized-light/pigment-solarized-dark"` pairing syntax follows your terminal's light/dark automatically.

Your own themes: drop TextMate theme files (JSON or the original `.tmTheme` plist) into the `themes/` config directory and run `/pigment` (a subcommand picker) or `/pigment convert` (a TUI selector, or `/pigment convert <name>`) — the converted `pigment-<name>.json` lands next to the source and, after `/reload`, registers like any bundled theme. See [CONFIG.md](CONFIG.md).

> **A note on the startup banner**: the loaded-resources list (`[Themes]`) now names all 65 registered themes — about ten extra lines at startup. That's pi's native rendering of registered themes, not a defect; `--no-themes` or the settings' theme filters can quiet it.

## Configuration

Optional, one file, two layers (project overrides global):

| Layer   | Path                                            |
| ------- | ----------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pigment/config.jsonc`   |
| Project | `<project>/.pi/extensions/pigment/config.jsonc` |

Three keys — that is the entire surface:

```jsonc
{
  // Tools pi-pigment does NOT register (falls back to pi's built-in tool).
  "disabledTools": [],
  // Left-edge change indicator: "bar" or "none".
  "indicatorStyle": "bar",
  // Token override (default "auto" follows the pi theme): a theme name,
  // a "light/dark" pair (pi's grammar), or an inline object — see
  // CONFIG.md.
  "syntaxTheme": "auto",
}
```

Config failures are scoped, never fatal: a malformed file skips its layer, an invalid value falls back per key — a config error never disables the renderer. See [CONFIG.md](CONFIG.md) for the `syntaxTheme` object form, theme-file discovery, and diff-root overrides, [`config/config.example.json`](config/config.example.json) for a complete example, and [`schemas/pi-pigment.schema.json`](schemas/pi-pigment.schema.json) for editor validation (add `"$schema": "https://raw.githubusercontent.com/kuoruan/pi-mono/master/extensions/pi-pigment/schemas/pi-pigment.schema.json"` to your config for completion).

## How it works

pi-pigment wraps the built-in tools from the pi SDK. The wrappers delegate execution untouched and replace only the rendering:

```
Old content ──┐
              ├── diff (structuredPatch) ── parse ── highlight (Shiki → ANSI)
New content ──┘                                          │
                                                         ├── inject diff bg
                                                         ├── inject word-level bg
                                                         └── wrap/fit to terminal
```

One Shiki highlighter instance serves all tools, with a 192-entry LRU cache for highlighted blocks; theme switches re-derive both the palette and the syntax theme.

## Credits & see also

pi-pigment was inspired by [pi-diff](https://github.com/phongndo/pi-diff) by phongndo.

Shell-command highlighting and heredoc language injection run on [@aliou/sh](https://github.com/aliou/sh) — thanks to its author, [Aliou Diallo](https://github.com/aliou), for the shell AST.

The two are complementary: pi-pigment renders each tool call inline; pi-diff adds a `/diff` review UI for session and git changes. If you want to review what the agent changed across the whole session, `pi install npm:pi-diff`.

## Development

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```

This package lives in the [pi-mono](https://github.com/kuoruan/pi-mono) workspace and follows its shared toolchain (oxlint, oxfmt, vitest, changesets).

## License

MIT — see [LICENSE](LICENSE).
