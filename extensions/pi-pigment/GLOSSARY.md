# pi-pigment

A Pi extension that repaints what pi prints: syntax-highlighted diffs, shell commands, grep hits, and file listings, colored from the active pi theme. It also ships the Shiki theme bundle as registered pi themes, so picking one in `/theme` repaints the whole pi.

## Language

### Configuration

**Config layer**:
One of the two config file locations: global (`~/.pi/agent/extensions/pigment/config.jsonc`) or project (`<cwd>/.pi/extensions/pigment/config.jsonc`).
_Avoid_: level, location

**Effective config**:
The deep-merged, schema-validated result of both layers, project overriding global, re-resolved at every session start.
_Avoid_: settings (reserved for pi's own settings)

**Config issue**:
A malformed file or schema violation recorded during loading. Invalid layers are skipped with recorded issues; the renderer never crashes.

### Surfaces

**Tool wrapper**:
A same-name re-registration of a built-in tool that delegates execution to the SDK original and replaces only its TUI rendering.
_Avoid_: override (execution is not overridden), hook

**Call/result stacking**:
The TUI's two-component shape for a tool row — `renderCall`'s output on top, `renderResult`'s appended below, both re-run on every redraw.
_Avoid_: rendering content in the call slot, result summaries in the result slot

**Render shell**:
The per-tool declaration telling the TUI how to frame the tool's rows: `"default"` for the standard tool box, `"self"` when the tool paints its own framing. Every wrapper declares it explicitly, never inherits it.

**Error frame**:
The rendering of a failed tool result, shared by every wrapper: the message drafted over the theme's error background, with the shell failure badge carried on the call header, not repeated here.

**Render state**:
The per-tool-call state object the TUI initializes empty and the wrapper's fields populate lazily. Typed per tool, so each wrapper sees only its own fields.
_Avoid_: one shared state interface

**Disabled tool**:
A tool name listed in `disabledTools` whose wrapper is not registered, falling back to Pi's built-in rendering.

**FFF yield**:
The pi-fff compatibility rule: when the FFF search extension is loaded, pi-pigment does not register its grep/find wrappers. Presence is probed through FFF's `/fff-mode` command, which registers at module load.
_Avoid_: forcing tools active to work around a conflict

### Diff model

**Parsed diff**:
The structured result of parsing a unified patch: typed lines (`add`/`del`/`ctx`/`sep`) with old/new line numbers, plus added/removed counts.

**Hunk**:
A contiguous run of changes with surrounding context, separated by `sep` lines in the parsed diff.

**View**:
A rendering layout. **Split** is side-by-side, used when the geometry allows; **unified** is stacked single-column, the fallback. The choice is per-render and purely geometric — no tool forces a view.

**Word-level emphasis**:
Brighter backgrounds injected at the changed character ranges of paired add/del lines, over the line-level diff background.

### Scheme

**Color math**:
The pure color conversions (decode, parse, composite, blend) and WCAG measures every scheme and syntax-theme derivation flows through. Owned by `src/core/color.ts`; it maps colors to colors or numbers, never to escapes.
_Avoid_: color math mixed into the escape layer

**Scheme**:
The set of diff background/foreground ANSI variables, one snapshot per frame, derived by a pure function and memoized per theme content. An explicit render input — nobody re-derives or reads ambient state mid-render.
_Avoid_: ambient scheme reads

**Auto-derive**:
The scheme's derivation path: added/context surfaces blend `toolDiffAdded` into `toolSuccessBg`, removed surfaces use `toolDiffRemoved`/`toolErrorBg`. Runs when the pi theme or the diff roots change.
_Avoid_: theme config (the scheme is configurable only through diff roots)

**Syntax theme**:
The token-color override layer, selected by the `syntaxTheme` key: a name from pi's theme-setting grammar, or a theme object resolving over a base. It overrides token colors only — chrome, canvas, and diff roots belong to the pi theme.
_Avoid_: diff theme (reserved for the scheme)

**Theme pair**:
An explicit `"light/dark"` slash pair; the half matching the pi theme's polarity renders. Bundled names are AA-enforced, user files render verbatim.
_Avoid_: family, preset

**Custom theme**:
A user-authored TextMate theme file in a config `themes/` directory (global or project), optionally carrying a `diff` extension key. Selectable by file stem before conversion, and still working after it.
_Avoid_: user theme

**Theme object**:
The inline `syntaxTheme` object. **Patch mode** (a `base` is given) overlays semantic colors and diff entries on the resolved base; **variant mode** (no base) defines a new theme from per-polarity variants, the polarity authority belonging to the author.
_Avoid_: theme patch (patch is one mode, not the whole object)

**Generated theme**:
A pi theme pi-pigment produced from a TextMate theme — bundled ones ship pre-generated, user files convert on demand via `/pigment convert`. Registered under the `pigment-` prefix.
_Avoid_: registered theme, converted theme

**External theme**:
Any pi theme that is not one of ours — built-ins, third-party, user-custom, or a renamed generated file. The detection chain treats them all identically.
_Avoid_: foreign theme

**Detection chain**:
The render-time resolution of the token layer, in order: an explicit `syntaxTheme` override; ours-detection (the active theme maps back to its Shiki source); the follower path (derive from the theme's own syntax colors). It runs per render on the live theme, so mid-session switches follow automatically.

**Converter**:
The pure function turning a materialized Shiki theme into a pi theme JSON document. Generation-time only, never at render time; its AA sweep applies to bundled ships, while user themes convert verbatim.

**Base layer / Override layer**:
The theming split. The base layer is the pi theme (chrome: borders, backgrounds, state colors, markdown, thinking). The override layer is `syntaxTheme` (tokens only).

**Diff roots**:
The scheme's derivation inputs — the added/removed sides, each with a `text` slot (the line color) and a `tint` slot (the word-emphasis anchor). The only diff-color override surface; the box canvas is not a root.

**Enforcement boundary**:
The rule splitting WCAG-AA-enforced colors (those pi-pigment supplies) from verbatim ones (those the user sets). It governs the whole pipeline, the diff highlight included.

**Grep block merge**:
Same-file hit/context lines highlight as one Shiki block per file, so grammar state flows across lines and the cache holds one entry per file instead of one per line.

**Pattern emphasis**:
The span-aware rewriter that brightens pattern occurrences inside highlighted grep hit lines and find basenames, plus a regex-safety gate that declines patterns that could freeze the TUI.
_Avoid_: emphasis through the scheme's type color, per-line emphasis (grammar state must flow)

**Collapsed view**:
The render-side window authority for every collapsed body (grep/find/ls and write's create preview): one window concept with a collapsed budget and an optional expanded cap, and one tail grammar that advertises the expand key.
_Avoid_: per-wrapper window choreography

**Muted chrome**:
The renderer's dimmed furniture — separators, "more lines" notes, line numbers — derived from the theme's own `dim`/`muted` slots, falling back to fixed grays only when the theme lacks them.

**Hunk gap**:
The skipped unmodified lines between two hunks, computed by one shared authority and rendered as the `+N lines` separator label.

**Row frame**:
The per-line gutter composition (border, line number, sign, backgrounds) both diff views render rows through.

**Grammar-state seed**:
The file text before a diff's last visible hunk, fed to the tokenizer so embedded grammars (vue `<script>`, html `<style>`) color mid-file slices correctly. Callers own the source: write slices from its arguments, edit reads from disk.
_Avoid_: seeding from the wrong side's line numbers

**Async preview task**:
The swap payload attached to a Text component, carrying the render closure and two orthogonal stamps: a width-neutral identity (the attach guard) and a width-aware key (the render cache). The stamps must see every input the closure captures.
_Avoid_: invalidate during render (re-enters the pipeline synchronously)

**Stats bridge**:
The write/edit call-header counts flowing through `result.details → renderResult → render state`, bridged a frame later rather than through a side channel.
_Avoid_: execute-scoped stat stashes (a reload orphans them)

**Command highlight**:
The shell tools' call header: the command rendered in shell grammar over the theme's title base, swapped in async once args complete. The command's language is known by definition, so no guessing.
_Avoid_: guessing the output's language from the command

**Code injection region**:
A source range of a bash command that renders in a non-shell grammar — a heredoc body, a heredoc file-write, or an inline code argument — located by the shell AST. Parse failures fall back to a line scanner, then to pure shell coloring.
_Avoid_: output-language guessing

**Inert text**:
User data neutralized so it can only produce glyphs, never terminal control, applied at the intake boundaries.
_Avoid_: sanitization by stripping, neutralization at the output sink

### Rendering pipeline

**Cell**:
The unit every width-aware walk of styled text visits: one escape sequence (zero columns, zero characters) or one visible unit (one or two columns). Clusters are never split mid-grapheme.
_Avoid_: hand-rolled escape-skipping loops

**Highlight cache**:
A memo of Shiki-highlighted code blocks keyed by theme + language + code. No engine prewarm by design: every highlight consumer renders through an async plain-then-styled upgrade that hides load latency.
_Avoid_: warmup timers, "kick" side effects on the highlight path

**Large-diff fallback**:
For oversized content, Shiki highlighting is skipped but the diff structure still renders.
