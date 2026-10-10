# pi-pigment

Pigment for your pi: it repaints what pi prints — diffs, shell commands, search hits, and file listings — in the colors of the active pi theme.

## Language

### Configuration

**Config layer**:
One of the two config file locations: global (`~/.pi/agent/extensions/pigment/config.jsonc`) or project (`<cwd>/.pi/extensions/pigment/config.jsonc`).
_Avoid_: level, location

**Effective config**:
The merged, schema-validated result of both layers, project overriding global, re-resolved at every session start.
_Avoid_: settings (reserved for pi's own settings)

**Config issue**:
A malformed file or invalid value met while loading; that layer is skipped and the issue recorded, never a crash.

### Rendering surfaces

**Renderer resolver**:
pi-pigment's one registration: it supplies pi-pigment's rendering for a built-in tool name, or yields the name to pi.
_Avoid_: tool wrapper, override

**Yield**:
Handing a tool name back to pi's own rendering, for a name pi-pigment must not decorate.

**Tool renderer**:
pi-pigment's rendering for a single tool; it owns no execution and no tool definition.
_Avoid_: wrapper, tool definition

**Call/result stacking**:
A tool row is the call's rendering with the result's rendering appended below; both re-run on every redraw.
_Avoid_: content in the call slot, summaries in the result slot

**Render shell**:
Whether the TUI frames a tool's rows in the standard box, or the tool frames itself.
_Avoid_: ad hoc per-tool framing

**Error frame**:
The rendering shared by every failed tool result.
_Avoid_: per-tool error styling

**Render state**:
The per-call state a tool renderer keeps, populated lazily and typed per tool.
_Avoid_: one shared state shape

**Disabled tool**:
A tool name pi-pigment is configured not to decorate, leaving pi's built-in rendering in place.

**FFF yield**:
The compatibility rule that yields `grep`/`find` when the pi-fff search extension is present.
_Avoid_: forcing tools active to dodge a conflict

### Diff model

**Parsed diff**:
A unified patch read into typed lines (`add`/`del`/`ctx`/`sep`) with old and new line numbers and change counts.

**Hunk**:
A contiguous run of changes with its surrounding context.

**View**:
A rendering layout: **split** (side by side, when the geometry allows) or **unified** (stacked, the fallback). Never forced by a tool.

**Word-level emphasis**:
Brighter backgrounds on the changed character ranges of paired add/del lines.

### Scheme and themes

**Color math**:
The pure color conversions and contrast measures every palette derivation flows through.
_Avoid_: color math mixed into escape construction

**Scheme**:
The diff background and foreground colors for one frame, derived purely and memoized; an explicit render input, never read ambiently.
_Avoid_: ambient scheme reads

**Auto-derive**:
Deriving the diff colors from the pi theme's own diff and state slots.
_Avoid_: theme config

**Syntax theme**:
The token-color override layer, selected by `syntaxTheme`; it overrides tokens only, never chrome or the canvas.
_Avoid_: diff theme (that is the scheme)

**Theme pair**:
A `"light/dark"` slash pair; the half matching pi's polarity renders.
_Avoid_: family, preset

**Custom theme**:
A user-authored TextMate theme in a config `themes/` directory.
_Avoid_: user theme

**Theme object**:
The inline `syntaxTheme` object: **patch mode** overlays a base, **variant mode** defines a new theme from per-polarity variants.
_Avoid_: theme patch

**Generated theme**:
A pi theme pi-pigment produced from a TextMate theme.
_Avoid_: converted theme, registered theme

**External theme**:
Any pi theme that is not one of pi-pigment's.
_Avoid_: foreign theme

**Detection chain**:
How the token layer is resolved at render time: an explicit override, then ours-detection, then the follower path.

**Converter**:
The generation-time function that turns a Shiki theme into a pi theme.

**Base layer / Override layer**:
The theming split: the pi theme owns chrome, `syntaxTheme` owns tokens.

**Diff roots**:
The diff-color override inputs — per side a `text` (line color) and a `tint` (word-emphasis anchor).

**Enforcement boundary**:
Colors pi-pigment supplies are contrast-enforced; colors the user sets render verbatim.

### Rendering pipeline

**Grep block merge**:
Highlighting same-file search hits as one block, so grammar state flows across lines.

**Pattern emphasis**:
Brightening a pattern's occurrences inside search hits and find basenames, behind a regex-safety gate.

**Collapsed view**:
The shared windowing rule for every collapsed body.

**Muted chrome**:
A renderer's dimmed furniture — separators, notes, line numbers.

**Hunk gap**:
The unmodified lines skipped between two hunks.

**Row frame**:
The per-line gutter (border, line number, sign, backgrounds) both diff views share.

**Grammar-state seed**:
The text before a diff's last visible hunk, fed to the tokenizer so embedded grammars color mid-file slices correctly.

**Async preview task**:
The payload a renderer attaches to paint highlighted content once it is ready, without blocking the first frame.

**Write details channel**:
The capture of a write's old and new content, emitted only when the file that landed matches what the call wrote.

**Stats bridge**:
Write and edit call-header counts, surfaced one frame after the result.
_Avoid_: execute-scoped stat stashes

**Command highlight**:
The shell call header's command, rendered in shell grammar.

**Code injection region**:
A range of a shell command that renders in a non-shell grammar — a heredoc, a heredoc file-write, or an inline code argument.
_Avoid_: guessing the output's language from the command

**Inert text**:
User data neutralized so it can only produce glyphs, never terminal control.

**Cell**:
The unit a width-aware walk visits: one escape sequence or one visible grapheme cluster.

**Highlight cache**:
A memo of highlighted code blocks.

**Large-diff fallback**:
Past a size threshold, highlighting is skipped while the diff structure still renders.
