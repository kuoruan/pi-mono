# pi-pigment

**Pigment for your pi.**

pi-pigment repaints what pi prints. Diffs get word-level change emphasis, shell commands render in their own grammar, grep hits are highlighted in the hit file's language, and file listings color each entry by type. Every color comes from the pi theme you're already wearing, so the rendering follows whatever palette you run. Nothing to configure by default; three keys if you want to bend it.

## What it renders

| Tool         | Rendering                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write`      | Diff with word-level change emphasis: split when balanced and the terminal is wide, unified (stacked) otherwise; new files render as a syntax-highlighted preview                                         |
| `edit`       | Split (side-by-side) diff, auto-falling back to unified on narrow terminals or wrap-heavy hunks                                                                                                           |
| `bash`       | The command itself renders in shell grammar (strings, flags, operators); the output keeps pi's native display: timing, preview windows, truncation footers (the native muted Elapsed/Took stay uncolored) |
| `grep`       | Hit lines highlighted in the hit file's language with the matched pattern emphasized; `file:line:` prefixes stay muted                                                                                    |
| `ls`         | Entries colored by type (directories accent + bold, code files tinted) in a tree listing with `├──`/`└──` connectors                                                                                      |
| `find`       | Result paths colored by type: dim directory prefix, type-colored basename (accent dirs, tinted code files, warning-tinted limit notices)                                                                  |
| `powershell` | The Windows shell twin: command colored in PowerShell grammar with the `PS>` prompt; output keeps pi's native display (Windows-only execution; native Elapsed/Took stay muted)                            |

Details worth knowing:

- Word-level emphasis: changed characters inside paired add/del lines get brighter backgrounds, so a one-word tweak never hides in the line
- Grammar accuracy: Shiki brings its full bundled language set (340+ grammars, detection via Shiki's alias registry)
- Embedded code injection: bash commands parse via a shell AST (@aliou/sh):
  - heredoc bodies render in their interpreter's grammar (`python3 << EOF`)
  - heredoc file-writes in the target's (`cat > app.py << EOF`)
  - inline code args too (`python -c '...'`, `node -e '...'`); parse failures degrade gracefully
- Zero-config palette: diff backgrounds blend the theme's `toolDiffAdded`/`toolDiffRemoved` foregrounds into its `toolSuccessBg`/`toolErrorBg`; the syntax theme follows the detection chain:
  - a `pigment-*` theme maps back to its Shiki source (full `tokenColors` precision: bundled sources AA-fitted at render time, your converted sources verbatim)
  - anything else derives from its own nine `syntax*` colors, WCAG-AA-adjusted for the render backgrounds
  - an explicit `syntaxTheme` override paints tokens only; the canvas always belongs to the pi theme
- Collapsed search output: grep/find/ls bodies collapse past the native renderers' own budgets (15/20/20 lines) with a `ctrl+o`-to-expand tail carrying the measured execution time in the success color — a tail footer only exists on a settled, successful call (an error renders the error frame instead, its own `Took` colored by the failure kind)
- Large-input fallback: highlighting skips past 80,000 characters per block; the diff structure still renders
- Strict edit safety: execution always delegates verbatim to the SDK tools (matching, uniqueness, overlap checks, mutation queues, aborts, BOM, and EOL preservation); only the rendering is replaced

## Install

Requires pi ≥ 0.85.0 and Node ≥ 22.

```bash
pi install npm:pi-pigment
```

Restart pi and the rendering takes over. No config needed.

## Themes

pi-pigment ships the whole Shiki bundle as **pi themes**: after install, `/settings` → Theme lists every one under the `pigment-` prefix (`pigment-solarized-light`, `pigment-github-dark`, …). Pick one and the entire pi follows: borders, boxes, backgrounds, and the diff renderer, which maps the selection back to the original Shiki theme for full-precision syntax colors (AA-protected on the actual canvas). The selection persists in your pi settings like any other theme. The `"theme": "pigment-solarized-light/pigment-solarized-dark"` pairing syntax follows your terminal's light/dark automatically.

Your own themes: drop TextMate theme files (JSON or the original `.tmTheme` plist) into the `themes/` config directory and run `/pigment` (a subcommand picker) or `/pigment convert` (a TUI selector, or `/pigment convert <name>`). The converted `pigment-<name>.json` lands next to the source and, after `/reload`, registers like any bundled theme. See [config.md](docs/config.md).

> **A note on the startup banner**: the loaded-resources list (`[Themes]`) now names all 65 registered themes — about ten extra lines at startup. That's pi's native rendering of registered themes, not a defect; `--no-themes` or the settings' theme filters can quiet it.

## Configuration

Optional, one file, two layers (project overrides global):

| Layer   | Path                                            |
| ------- | ----------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pigment/config.jsonc`   |
| Project | `<project>/.pi/extensions/pigment/config.jsonc` |

The entire surface is three keys:

```jsonc
{
  // Tools pi-pigment does NOT register (falls back to pi's built-in tool).
  "disabledTools": [],
  // Left-edge change indicator: "bar" or "none".
  "indicatorStyle": "bar",
  // Token override (default "auto" follows the pi theme): a theme name,
  // a "light/dark" pair (pi's grammar), or an inline object — see
  // config.md.
  "syntaxTheme": "auto",
}
```

Config failures are scoped. A malformed file skips its layer, an invalid value falls back per key, and a config error never disables the renderer. See [config.md](docs/config.md) for the `syntaxTheme` object form, theme-file discovery, and diff-root overrides, [`config/config.example.json`](config/config.example.json) for a complete example, and [`schemas/pi-pigment.schema.json`](schemas/pi-pigment.schema.json) for editor validation (add `"$schema": "https://raw.githubusercontent.com/kuoruan/pi-mono/master/extensions/pi-pigment/schemas/pi-pigment.schema.json"` to your config for completion).

## How it works

pi-pigment wraps the built-in tools from the pi SDK. The wrappers delegate execution untouched and replace only the rendering:

```
Old content ──┐
              ├── diff (structuredPatch) ── parse ── highlight (Shiki → ANSI)
New content ──┘                                          │
                 ┌───────────────────────────────────────┘
                 │ (split verdict first: side-by-side when balanced
                 │  and the terminal is wide, unified otherwise)
                 ├── inject diff bg
                 ├── inject word-level bg
                 └── wrap/fit to terminal
```

A single Shiki instance backs every tool, cached per block (192-entry LRU); switching themes rebuilds the palette and the grammar set together.

Shell commands take a different path. The command text is highlighted in shell grammar (shellscript or PowerShell) with its prompt glyph, while the output stays with pi's native renderer. Plain text shows first and the highlighted form swaps in once ready, so a long-running command never flickers. Heredoc bodies and inline code args (`python -c '...'`) are detected by a shell AST and highlighted in their own languages.

Grep, find, and ls share the type-color rules. Hit lines render in the hit file's language (one block per file, so grammar state flows across lines) with the matched pattern emphasized in bold accent; prefixes stay muted and context lines dim. Paths are colored by type: dim directory prefix, type-colored basename (accent for directories, a syntax-family tint for code files). Toolbox output closes channel-scoped (foreground only), never with the diff canvas reset, so pi's line-level frame survives.

## Credits & see also

pi-pigment was inspired by [@heyhuynhgiabuu/pi-diff](https://github.com/buddingnewinsights/pi-diff).

Shell-command highlighting and heredoc language injection run on [@aliou/sh](https://github.com/aliou/sh). Thanks to its author, [Aliou Diallo](https://github.com/aliou), for the shell AST.

Building an extension that wraps the same tools? See [docs/integrating.md](docs/integrating.md) for the `render-kit` borrowing API and the first-wins coexistence rules.

## For extension authors

If your extension registers its own `bash` (a sandboxed execute, an access gate) or ships themes, it can borrow pi-pigment's rendering instead of racing it for the tool name. `pi-pigment/render-kit` installs pi-pigment's renderers on your tool definitions and leaves your `execute` untouched. There is also a zero-dependency channel (`globalThis` publication) for extensions that must not depend on this package. See [docs/integrating.md](docs/integrating.md): it covers the API, the pitfalls (load order, shell settings, silent first-wins), and the coexistence rules.

## Development

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```

This package lives in the [pi-mono](https://github.com/kuoruan/pi-mono) workspace and follows its shared toolchain (oxlint, oxfmt, vitest, changesets).

## License

MIT — see [LICENSE](LICENSE).
