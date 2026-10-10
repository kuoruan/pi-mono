# pi-pigment

**Pigment for your pi.**

pi-pigment repaints what pi prints: diffs get word-level change emphasis, shell commands render in their own grammar, grep hits are highlighted in the hit file's language, and file listings color each entry by type. Every color comes from the pi theme you are already wearing, so the rendering follows your palette. Nothing to configure by default; four keys if you want to bend it.

## What it renders

| Tool         | Rendering                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write`      | Diff with word-level change emphasis: split when balanced and the terminal is wide, unified otherwise; new files render as a syntax-highlighted preview                    |
| `edit`       | Split (side-by-side) diff, falling back to unified on narrow terminals or wrap-heavy hunks                                                                                 |
| `bash`       | The command in shell grammar (strings, flags, operators); the output keeps pi's native display                                                                             |
| `grep`       | Hit lines highlighted in the hit file's language with the matched pattern emphasized                                                                                       |
| `ls`         | Entries colored by type in a tree listing                                                                                                                                  |
| `find`       | Result paths colored by type (dim directory prefix, type-colored basename)                                                                                                 |
| `powershell` | The Windows shell twin: command in PowerShell grammar with the `PS>` prompt; output keeps pi's native display                                                              |
| `read`       | Path with a pinned `:offset-limit` range; SKILL.md/docs/lockfiles collapse to labels; secret-bearing files wear a `⚠ sensitive` flag with dotenv values masked in the body |

Details worth knowing:

- **Word-level emphasis** — changed characters inside paired add/del lines get brighter backgrounds, so a one-word tweak never hides in the line.
- **Grammar accuracy** — Shiki's full bundled language set, detected from the file path.
- **Embedded code injection** — bash heredocs, heredoc file-writes, and inline code args (`python -c '...'`, `node -e '...'`) render in their interpreter's own grammar; parse failures degrade gracefully.
- **Zero-config palette** — diff backgrounds derive from the pi theme, and the syntax theme follows a detection chain: a `pigment-*` theme maps back to its Shiki source for full token precision, any other theme derives from its own syntax colors (contrast-adjusted), and an explicit `syntaxTheme` overrides tokens only.
- **Collapsed search output** — grep/find/ls bodies collapse with a `ctrl+o`-to-expand tail; a settled, successful call also shows its execution time.
- **Secret masking is best-effort** — only `KEY=value` assignment lines mask; the `⚠ sensitive` banner is the signal, not a redaction guarantee.
- **Strict edit safety** — execution always delegates verbatim to pi's own tools (matching, uniqueness, overlap checks, aborts, BOM and EOL preservation); only the rendering is replaced.

## Install

Requires pi ≥ 1.0.1 and Node ≥ 22.

```bash
pi install npm:pi-pigment
```

Restart pi and the rendering takes over. No config needed.

## Themes

pi-pigment ships the whole Shiki bundle as pi themes: after install, `/settings` → Theme lists around 65 of them under the `pigment-` prefix (`pigment-solarized-light`, `pigment-github-dark`, …). Pick one and the whole pi follows — borders, boxes, backgrounds, and the diff renderer, which maps the selection back to the original Shiki theme for full-precision syntax colors. The selection persists like any other pi theme, and `"pigment-solarized-light/pigment-solarized-dark"` follows your terminal's light/dark automatically.

Your own themes: drop TextMate theme files (JSON or the original `.tmTheme` plist) into the `themes/` config directory and run `/pigment convert` (a TUI selector, or `/pigment convert <name>`, or the `/pigment` subcommand picker). The converted `pigment-<name>.json` lands next to the source and registers after `/reload`. See [config.md](docs/config.md) for details.

> **Startup banner**: the loaded-resources list (`[Themes]`) names every registered theme (~65) — about ten extra lines at startup. That is pi's native rendering of registered themes, not a defect; `--no-themes` or the settings' theme filters can quiet it.

## Configuration

Optional, one file, two layers (project overrides global):

| Layer   | Path                                            |
| ------- | ----------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pigment/config.jsonc`   |
| Project | `<project>/.pi/extensions/pigment/config.jsonc` |

Four keys:

```jsonc
{
  // Tools pi-pigment does NOT decorate (pi's built-in rendering is used).
  "disabledTools": [],
  // Left-edge change indicator: "bar" or "none".
  "indicatorStyle": "bar",
  // Long call headers: "on" (ellipsis, default) or "off" (always full).
  "headerEllipsis": "on",
  // Token override (default "auto" follows the pi theme): a theme name,
  // a "light/dark" pair, or an inline object — see config.md.
  "syntaxTheme": "auto",
}
```

Config failures are scoped: a malformed file skips its layer, an invalid value falls back per key, and a config error never disables the renderer. See [config.md](docs/config.md) for the object form and diff-root overrides, [`config/config.example.json`](config/config.example.json) for a complete example, and [`schemas/pi-pigment.schema.json`](schemas/pi-pigment.schema.json) for editor completion.

## How it works

pi-pigment decorates the eight built-in tools through pi's `registerToolRenderer` resolver. It registers no tool and never touches execution, so the model-facing result always stays pi's own — only the rendering is replaced. A name another extension owns, a name you disabled, or `grep`/`find` when the pi-fff search extension is present is yielded back to pi's own renderers.

Shell commands keep pi's native output display; only the command itself is re-highlighted. Plain text shows first and the highlighted form swaps in once ready, so a long-running command never flickers.

## Credits

pi-pigment was inspired by [@heyhuynhgiabuu/pi-diff](https://github.com/buddingnewinsights/pi-diff). Shell-command highlighting and heredoc language injection run on [@aliou/sh](https://github.com/aliou/sh); thanks to [Aliou Diallo](https://github.com/aliou) for the shell AST.

## Development

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```

This package lives in the [pi-mono](https://github.com/kuoruan/pi-mono) workspace and follows its shared toolchain (oxlint, oxfmt, vitest, changesets).

## License

MIT — see [LICENSE](LICENSE).
