# pi-pigment

A Pi extension that provides themes and renders tool output — the Shiki bundle converted to registered pi themes (pick one in /theme and the whole pi follows), plus syntax-highlighted diffs for `write`/`edit`, shell-grammar bash/powershell commands with AST-driven heredoc injection, highlighted grep hits, type-colored `ls`/`find` listings. This file pins down the ubiquitous language so reviews, navigators (human or AI), and future contributors share one vocabulary.

## Language

### Configuration

**Config layer**: One of the two file dimensions: global (`~/.pi/agent/extensions/pigment/config.jsonc`) or project (`<cwd>/.pi/extensions/pigment/config.jsonc`). _Avoid_: level, location.

**Effective config**: The deep-merged, zod-validated result of both layers (project overrides global), re-resolved at every session_start (startup, reload, fork, resume). The entire configuration surface: `disabledTools`, `indicatorStyle`, and `syntaxTheme` (a string or a theme patch object). _Avoid_: settings (reserved for pi's own settings).

**Config issue**: A malformed file or schema violation recorded during loading. Cosmetic config fails safe: invalid layers are skipped with recorded issues, never crash the renderer.

### Surfaces

**Tool wrapper**: A re-registration of a built-in tool (same name) that delegates execution to the SDK original and replaces only the TUI rendering.

**Call/result stacking**: The TUI renders a tool row as TWO components in one block — renderCall's output on top, renderResult's output appended below (both re-run on every updateDisplay, including expand toggles). Every wrapper follows one shape:

- the call slot renders argument feedback (label, path, command, streaming counts) AND the result summary once it lands — bridged through render state: edit's `1 edit (12 diff lines) +2 -1`, write's `✓ new file (N lines)` / `+N -M` / `✓ no changes`, all in the same header-suffix position
- the result slot renders ONLY content (diffs, outputs, previews): write's create preview is the numbered body alone (its ✓ lives in the header); the no-change result slot is empty (the native write's success shape)

Tool header paths carry OSC-8 file links (capability-gated, wrapped AFTER inertText — the order is a hard constraint). _Avoid_: rendering content in the call slot (duplicates the result's content, and the call render loses the create/write distinction on restore — the file exists by then), result summaries in the result slot (two positions for one grammar), cross-renderer contracts through shared state to coordinate the two slots.

**Render shell** (ToolDefinition.renderShell): The per-tool declaration telling the TUI how to frame the tool's rows.

- "default" — the TUI outlets rows inside the standard tool box: background + padding; pi-pigment's plain-Text renders depend on the box's background coat
- "self" — rows outlet BARE, the tool paints its own framing (the native edit tool's call component is its own Box flipping bgFn per call state)

Every wrapper declares "default" EXPLICITLY in its WrapperSpec: the factory spreads the SDK origin's definition first, and an inherited "self" silently strips the frame background from our renders (the edit error-frame came out background-less and lost the Took spacing — the bug this pin fixes). _Avoid_: inheriting the origin's value (upstream can flip a built-in to "self" and silently break every wrapper's coats).

**Error frame**: The errored-result rendering (`formatToolErrorResult`, beside the shell badge taxonomy in header.ts), invoked by the factory's renderResult error branch for EVERY wrapper: drafts the message at width, paints the box background from the theme's `toolErrorBg`, and pre-wraps each visual row so every continuation carries the indicator-bar column.

- Header ownership is tool-kind based: shell tools (bash/powershell) frame their own header line plus a parsed status badge ("✗ exit N" — 128-255 the signal range, "✗ timeout Ns", "✗ aborted"); all other tools render body-only (the call header already names the tool, so a validation-failure frame stays a bare message).
- The re-arm guard is the protocol's identity stamp (see Async preview task).

**Render state**: The per-tool-call state object the TUI initializes as `{}` and the wrapper's fields populate lazily.

- Typed per tool (`ShellState`, `WriteState`, `EditState`), so each wrapper sees only its own fields. _Avoid_: one shared state interface (a union bag every wrapper sees whole).
- `ShellState` is co-authored with the SDK: the native bash/powershell renderResult (the output-delegation target) reads and writes its timing fields (`startedAt`/`endedAt`/`interval`) — the type is the contract both sides write into.
- One known cosmetic quirk is accepted: the write wrapper's existence probe reads the filesystem at render time, so a restored create shows the "write" label (the file exists by then; the "✓ new file" result line below carries the truth). Fixing it would need a renderResult→renderCall state bridge, the cross-renderer contract this codebase avoids.

pi-pigment registers `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `powershell` wrappers (grep/find yield to pi-fff when it is loaded — see FFF yield). _Avoid_: override (execution is not overridden), hook.

**Disabled tool**: A tool name listed in `disabledTools` whose wrapper is not registered, falling back to Pi's built-in rendering.

**FFF yield**: The pi-fff compatibility rule: when the FFF search extension is loaded, pi-pigment does not register its grep/find wrappers (all fff modes).

- The presence signal is fff's `/fff-mode` command — commands register at module load, before any session_start, so the probe is order-safe; the tool vocabulary (ffgrep/fffind) is the secondary signal.
- Originally — a same-name registration from pi-pigment (which loads first) would crowd out FFF's override-mode tools (first registration wins the name), silently replacing frecency search with the built-ins. ls stays (FFF has no ls).
- Wrapping another extension's tools outright is structurally impossible: the API exposes no definition lookup, and the register-first-to-win ordering conflicts with needing the other extension's execute.

_Avoid_: setActiveTools to force-activate dormant tools (extending the agent's tool surface is the user's call, not a renderer's). The `disabledTools` config key's valid values: `write`, `edit`, `bash`, `grep`, `find`, `ls`, `powershell`.

### Diff model

**Parsed diff**: The structured result of parsing a unified patch: `lines` (typed `add`/`del`/`ctx`/`sep` with old/new line numbers), `added`/`removed` counts. Produced by the diff parser as a pure function.

**Hunk**: A contiguous run of changes with surrounding context, separated by `sep` lines in the parsed diff.

**View**: A rendering layout. **Split** — side-by-side, used for `write`/`edit` diffs when the geometry allows (wide terminal, balanced sides, low wrap ratio). **Unified** — stacked single-column, the fallback when split does not fit. The choice is per-render and purely geometric — no tool forces a view.

**Word-level emphasis**: Brighter backgrounds injected at changed character ranges of paired add/del lines, on top of the line-level diff background.

### Palette

**Color math**: src/core/color.ts — the pure color conversions (ANSI-color decode, hex parse/render, alpha compositing, RGB blend) and WCAG measures (luminance, contrast) that every palette and syntax-theme derivation flows through. No SGR escape production here — ansi.ts owns the escape layer; this module maps colors to colors or numbers (TinyColor-backed; ADR 0001's colord rejection note). _Avoid_: color math in ansi.ts (escape production and color math are separate concerns — the split keeps each to one home).

**Palette**: The set of diff background/foreground ANSI variables — one snapshot, resolved once per pi theme and diff-root overrides by the palette module's singleton memo. The resolved snapshot is an EXPLICIT render input: wrappers pass `resolveDiffPalette(theme)`'s return value down through the views, layout primitives, and header painters — nobody re-reads the singleton mid-render. _Avoid_: ambient palette reads.

**Auto-derive**: The palette derivation path: add/context surfaces blend `toolDiffAdded` foreground into `toolSuccessBg`; removed surfaces use `toolDiffRemoved`/`toolErrorBg`. Runs when the pi theme or the effective diff roots change; no presets, no environment variables. _Avoid_: theme config (the palette is only configurable through diff roots).

**Syntax theme**: The TOKEN override layer, selected by the `syntaxTheme` key.

- A string in pi's theme-setting grammar ("auto", a single theme name — Shiki-bundled or a themes/ file stem — or an explicit "light/dark" slash pair) or a theme object resolving over a base.
- "Auto" follows the active pi theme through the detection chain: a generated theme maps to its Shiki source (full tokenColors precision); any other theme derives from its own nine syntax colors (an unresolvable derivation renders unhighlighted — no substitute fallback).
- An explicit value overrides ONLY token colors — chrome, canvas, and diff roots belong to the pi theme.

Three homes: the file channel (discovery, parsing, the virtual bundled file) lives in theme-file; session-time selection strategy lives in theme-resolver; render-time interpretation (detection chain, polarity gating, patches-continue-on-auto) lives in theme-selection. _Avoid_: diff theme (reserved for the palette).

**Theme pair**: An explicit "light/dark" slash pair ("github-light/github-dark"): the half matching the pi theme's polarity renders. Shiki-bundled names are AA-enforced against the blend backgrounds (matching auto's precise pipeline); user files render verbatim. The former curated families survive as CONFIG.md's recommended-pairs table. _Avoid_: family, preset.

**Custom theme**: A user-authored TextMate theme file in a config `themes/` directory (global or project layer) — VS Code JSON, TextMate JSON, or the original .tmTheme XML plist — optionally carrying a `diff` extension key for root overrides. Before conversion it is selectable as a token override by file stem; `/pigment convert` turns it into a generated theme (the output lands next to it; the source keeps working as the token override — conversion never retires it). _Avoid_: user theme (redundant).

**Theme object**: The inline `syntaxTheme` object. **Patch mode** (a `base` is given) overlays semantic `colors` and `diff` entries on the resolved base. **Variant mode** (no `base`) defines a new theme from per-polarity variants (`light`/`dark`), each carrying semantic `colors` and optional `diff` roots — the polarity authority belongs to the author. Only listed keys deviate; user-set values render verbatim. _Avoid_: theme patch (patch is one mode, not the whole object).

**Generated theme**: A pi theme pi-pigment produced from a TextMate theme through the converter — the bundled set ships pre-generated in the package `themes/` directory (pi's manifest discovers it); user theme files convert ON DEMAND through `/pigment convert` (the output lands NEXT TO the source, never in a cache). Registered under the `pigment-` prefix; the theme registry maps each name back to its source for ours-detection. _Avoid_: registered theme (registration is the mechanism, not the identity), converted theme (same).

**External theme**: Any pi theme that is not one of ours — built-ins (dark/light), third-party, user-custom, or a copied-and-renamed generated file. The detection chain treats them identically: the follower path (auto) derives from their nine syntax colors. _Avoid_: foreign theme.

**Detection chain**: The render-time resolution of the token layer, in order:

1. an explicit `syntaxTheme` override
2. ours-detection — the active pi theme's name is in the registry → the mapped Shiki theme, full precision (BUNDLED sources AA-enforced, USER sources verbatim)
3. the follower path — the pi theme's nine colors, AA-adjusted; also the degraded landing when a registered USER source file is gone (the precise pipeline never breaks)

Runs per render on the live theme (mid-session `/theme` switches follow automatically; identity-keyed memos re-resolve).

**Converter**: The pure function turning a materialized Shiki theme into a pi theme JSON document (53+3 tokens + the export section):

- the canvas becomes the box backgrounds (pending = success, zero shift)
- the error box blends the state error into the canvas at a polarity-gated ratio (25% on light canvases, 10% on dark — a 10% red blend over near-white reads as plain white in truecolor terminals, the aborted-create "white frame" report)
- state colors are polarity hues AA-protected on the canvas; diff roots extract from token greens/reds (the file's explicit `diff` key wins)
- the nine syntax colors ride scope classification

Generation-time only — never at render time. The AA sweep is the BUNDLED ship path only: the user-theme channel converts with `enforceAa: false` — author colors verbatim, the enforcement boundary (colors you set are never nudged).

**Base layer / Override layer**: The theming split (ADR 0006). The base layer is the pi theme (`/settings` → Theme): every chrome color — borders, box backgrounds, state colors, markdown, thinking — renders from it at runtime, zero runtime setting. The override layer is the `syntaxTheme` config: token colors only. A generated theme joins the base layer (picked via /theme); a Shiki theme joins the override layer (referenced via syntaxTheme).

**Diff roots**: The palette derivation inputs — `added`/`removed` sides with `text`/`tint` slots (ADR 0003, revised by 0006) — the only diff-color override surface.

- `text` (opaque `#rrggbb`, shorthand `#rgb` accepted) is the side's line color.
- `tint` (`#rrggbbaa`, shorthand `#rgba` accepted) anchors the word slot with the ladder scaling the family.
- Parsing and expansion are TinyColor's (`parseHexForm`; the slot predicate `isRootHex` is the single home of what each slot accepts).

The box canvas is NOT a root: the tool frame's three backgrounds are the pi theme's own slots — `toolPendingBg` (streaming), `toolSuccessBg` (success), `toolErrorBg` (error) — painted by the header helpers (`setToolSuccessBg`/`setToolErrorBg`; the pending header stays transparent over the Box's pending paint). Overriding roots re-runs derivation; palette outputs are never directly settable.

**Enforcement boundary**: The rule splitting AA adjustment from verbatim rendering.

- WCAG-AA-enforced against the effective renderer backgrounds: the colors pi-pigment supplies (auto-derived, Shiki-bundled names, the bundled ships' converter sweep, the ours-detection runtime's bundled load).
- Verbatim everywhere, including the diff highlight pipeline: the colors the user sets (custom themes, patches, diff roots, the user-theme channel's converted outputs with `enforceAa: false`, the ours-detection runtime's user-source load).

**Grep block merge**: Same-file hit/context lines highlight as ONE Shiki block per file (chunked at MAX_HL_CHARS), so grammar state flows across lines (a template literal spanning several hits colors consistently) and the highlight cache holds one entry per file instead of one per line.

**Pattern emphasis**: The SGR-span-aware rewriter that brightens pattern occurrences inside already-highlighted grep hit lines and find basenames (never splitting an escape sequence, re-opening the span's fg after each hit), plus the ReDoS gate (`riskyPattern`) that declines to compile quantified-group/backreference patterns — a frozen TUI is worse than an unemphasized line.

- The emphasis signal is BOLD + the theme's accent (the ripgrep/GNU grep convention — bold survives even where the accent overlaps a token color; `accentEmphasis` derives the spec).
- A generic text primitive in pattern-emphasis; the grep and find wrappers are its clients.

_Avoid_: emphasis via the palette's fgCode (the code-file type color — invisible when they coincide), per-line emphasis (grammar state must flow — see Grep block merge).

**Collapsed view**: The render-side window authority (`collapsedView`, in the tool-output module alongside the output memo and the Took footer) for every collapsed body — grep/find/ls and write's create preview alike.

- One window concept, two regimes: the collapsed budget (grep 15, find/ls 20, write 10 — the SDK native renderers' own numbers) and an optional expanded cap (write's MAX_RENDER_LINES).
- One tail grammar (`... (N more lines, <keyHint> to expand)` — the key hint resolves the user's binding, "ctrl+o" is only the default): the collapsed window advertises the expand key; an expanded cap reports the remainder without an affordance (nothing further to expand into); the `Took Xs` footer reads the factory-measured `pigmentElapsedMs` sideband.
- The agent's context keeps the full output.

**Diff previews are a third regime by design**: a hunk needs its context lines, so write-overwrite and edit previews show a fixed window (no expand key — the views' own `... (N more lines)` tail matches the grammar's glyph shape). _Avoid_: per-wrapper window choreography (the tail format is a user-visible invariant).

**Muted chrome**: The renderer's dimmed furniture — separators, "…N more lines" notes, line numbers — derives from the theme's own `dim`/`muted` slots (both required in pi's theme schema), falling back to fixed grays only when the theme lacks them.

**Hunk gap**: The skipped unmodified lines between two hunks — carried on the separator line's `gap` field (never overloaded onto `newNum`) and computed by one authority (`hunkGap`) shared by both parsers. Renders as the `+N lines` separator label.

**Row frame**: The per-line gutter composition (border + line number + sign + backgrounds) both views render rows through — one authority in row-frame.ts (the render module family: wrap.ts for wrapping, row-frame.ts for the gutter, word-diff.ts for word-level emphasis, inject-bg.ts for backgrounds, split-verdict.ts for the split/unified choice; render-shared.ts holds only the shared view contract); the views keep only pairing, column split, and separator styling.

**Grammar-state seed**: The embedded-grammar coloring input for diff hunks (vue/html): a diff slice shows no `<script>`/`<template>` tag, so tokenizing from the grammar's top level leaves script lines scope-less (the "vue partial diff renders uncolored" bug).

- The seed is the file text BEFORE the deepest visible hunk's newStart (`lastHunkNewStart` — the last hunk header inside the render window), so the prepended source covers EVERY visible hunk, not just the first (a hunk below its coverage renders uncolored — the vue bug's second face).
- The slice is passed to shiki's own `grammarContextCode` option (prepended code that participates in grammar inference but never in the output — token-identical to the manual `getLastGrammarState`→`grammarState` dance, one official option instead of a memo layer).
- It lives in `hlBlock`'s options `seed` field; the highlight cache key carries the seed's fingerprint.

Callers own the source: write slices `args.content` at the last visible hunk's newStart (zero I/O — the text is already in the call arguments); edit reads the post-edit file from disk (cached per path+mtime) — its render inputs (args = edit ops, details.patch = hunk slices) carry no full file text, and stashing one in details would duplicate the whole file into the session JSONL. _Avoid_: seeding from the wrong side's line numbers.

**Async preview task**: The swap protocol's payload (`PreviewTask`: identity, placeholder, fallback, invalidate, key, render) attached to a Text component. TWO stamps, orthogonal:

- `identity` (width-neutral) — the attach guard compares it: updateDisplay re-runs renderResult and re-attaches a fresh closure every cycle; only a CHANGED identity re-arms the placeholder, unchanged re-runs keep the rendered frame.
- `key` (width-aware) — the render loop's cache key: diff previews key on width so a resize re-renders; grep's highlight keys on content identity (length + FNV-1a fingerprint), the palette identity (a mid-session theme switch re-renders), the elapsed sideband (the footer-only delta between a streaming partial and the final frame), and the expand mode (a resize doesn't re-render it).

One rule: the stamps must see every input the closure captures. The attach writes the placeholder synchronously (the every-wrapper setText idiom) but NEVER invalidates.

Platform contract (upstream tool-execution.js): `ctx.invalidate()` = component invalidate + `updateDisplay()`, and updateDisplay SYNCHRONOUSLY re-invokes renderCall AND renderResult — an invalidate during render re-enters the pipeline (sync recursion; and during a session-restore replay the re-entry reset the replay's batch progress and re-printed the whole session's frames in a loop — the "bash errors + diffs printed N times" report). The async render's completion invalidates once (a microtask later, coalesced by the TUI) — the only sane call site. The identity guard doubles as the anti-re-entry insurance: the completion's updateDisplay re-attach hits the same identity and skips. `clearPreviewTask` is the synchronous-exit counterpart (renderEmpty / the plain fallback must drop the identity stamp too).

**Stats bridge**: The write/edit call-header suffix counts (+N −M / N edits +M lines) flowing through `result.details → renderResult → render state`, not a side channel:

- write's execute stashes its diff payload
- edit's execute delegates verbatim and renderResult parses the SDK's own `details.patch` (ADR 0005 amendment)

Either way renderResult bridges the counts into state, and the call header (which renders on every update) picks them up one frame later. Restored sessions show the suffix too — details and args persist. _Avoid_: execute-scoped stat stashes (a reload orphans them).

**Command highlight**: The shell tools' (bash/powershell) call header — the command rendered in shell grammar over a toolTitle base (uncolored tokens inherit it), swapped in async once args complete. The command's language is known by definition (it IS shell), so no guessing; the output renders through the SDK's native result renderer (delegation, lastComponent withheld). _Avoid_: output-language guessing from the command (misfires are worse than plain).

**Code injection region**: A source range of a bash command that renders in a non-shell grammar, located by the shell AST (@aliou/sh):

- heredoc bodies — the interpreter whitelist maps `python3 << EOF` → python
- heredoc file-writes — `cat > app.py << EOF` → the target extension's language
- inline code args — `python -c '...'` (the quoted word after the interpreter's code flag)

Opener resolution is position-associated (the parser may merge consecutive heredoc commands into one node, but every word and redirect keeps its source offset — the heredoc's line window recovers the true opener words; assignment prefixes and quoted write targets resolve through the AST's own words/redirect targets, which the pre-AST manual tokenizer could not); parse failures fall back to the line scanner (same region shape, one assembly loop), then to pure shell coloring. _Avoid_: output-language guessing (a different, deleted feature).

**Inert text**: User data neutralized so it can only produce glyphs, never terminal control.

`inertText` maps control characters to cat -v caret notation (`ESC` → `^[`) at the intake boundaries (diff parse, grep hit parse, write content, ls entries, find entries, shell commands), so every downstream computation (word-diff, highlighting, measurement, wrapping) sees the same inert bytes (ADR 0004). _Avoid_: sanitization-by-stripping (silently alters content), sink-side neutralization (breaks span alignment).

### Rendering pipeline

**Cell**: The unit every width-aware walk of styled text consumes — one SGR escape (free: zero columns, zero characters) or one code point (one visible character, one or two columns; East-Asian wide and regional indicators count 2).

- Produced by `iterateCells`, consumed by wrapping, fitting, background injection, and measurement.
- Pattern emphasis is the one documented exemption (it matches on spans between escapes, not cells); `ansiState` is a separate shape (a whole-string state reduction).

_Avoid_: hand-rolled escape-skipping loops (the pre-Cell walkers — five variants of the same walk was where span-alignment bugs lived).

**Highlight cache**: Module-level LRU memo of Shiki-highlighted code blocks keyed by theme + language + code.

- No engine prewarm, by design and by measurement: the shiki module's ~28ms import is paid at extension load (the static registry import), ensureCore's remaining work is ~4ms (engine 0.5ms + grammar 3ms), and every hlBlock consumer renders through an async plain-then-styled upgrade that hides any load latency — the dominant first-use cost (regex compilation at first tokenize, 10-60ms) was never warmable by preloading a grammar anyway.
- Shiki's own guidance is the lazy singleton (ensureCore's promise memo); VS Code renders plain and restyles when the tokenizer catches up — the same model.
- One adjacent memo: the theme REGISTRATION (core.loadTheme) is skipped when the same theme object is already registered under its name — a theme switch's per-block re-normalization was ~0.3s across a loaded session.

_Avoid_: warmup timers, "kick" side effects on the highlight path (a timed front-run of 4ms behind an invisible path is superstition, not strategy).

**Large-diff fallback**: For oversized content, Shiki highlighting is skipped but the diff structure still renders.

## Relationships

- **pi-pigment → upstream Pi**: Consumes `@earendil-works/pi-coding-agent` (SDK tool factories, `ExtensionAPI`, `Theme`) and `@earendil-works/pi-tui` (Text component) as immutable external seams.
- **pi-pigment's identity**: Rendering-only (ADR 0005) — same-name wrappers over built-in definitions, execute delegated verbatim; never implements tools, never activates tools, never bundles engines. What the environment activates, pi-pigment decorates; what nobody activates, idles.
