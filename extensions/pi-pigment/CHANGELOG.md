# pi-pigment

## 0.2.3

### Patch Changes

- 98a72f1: Dim benign shell exit 1: grep/rg/ack/test/diff-family no-match badges render muted instead of error red.
- e01732b: Paint grep/find matches as blocks: the match keeps its bold accent foreground over pi's own searchMatchBg background (the surface the TUI's search uses), and the match close re-opens the line canvas (toolSuccessBg) instead of a bare 49m so the row past the match keeps its background (`baseBg`, mirroring `baseFg`).
- fefb7e5: Own the output tools' shared result-body assembly in `output-assembly`: the empty guard, swap key, settled-frame shortcut, windowed plain body, and preview-task attach live once — grep/find/ls supply only prefix, budget, notice, and their styled callback.
- 4110034: Unify the output tools' vertical rhythm: the collapsed tail's segments (expand hint, limit notice, Took) each take their own row with a blank line between and Took closing the tail (the native bash order); the body leads with a header gap (the native bash renderer's leading newline) and hugs a collapse hint (`... (N more lines)`) while a notice/Took-led tail breathes below a blank line (`joinBodyTail`); `collapsedView` returns the hidden count (`CollapsedWindow`) so wrappers stop recomputing it.
- d7889a7: Shell failures read at a glance: bash/powershell call headers now carry the parsed failure badge inline as a muted `·`-separated suffix — `$ cmd · ✗ exit 1` (`✗ exit 143`, `✗ timeout 30s`, `✗ aborted`, and the new `✗ terminated` for the upstream "Command terminated without an exit code" status line) — composed fresh per frame outside the highlight cache, with the args' own `(timeout Ns)` declaration suffix gone (the badge is the one timeout wording). The settled success frame rides the symmetric plain check — `$ cmd · ✓` (bold, success-colored, after the same muted `·`) — pending frames stay bare. The error frame stays body-only on a recognized status line (its bare name header remains only for unrecognized shell failures), and the failure-kind color mapping lives in one home beside the ✗-prefixed label forms.
- ad1d38f: Took footers carry the call's state color: collapsed grep/find/ls tails render green (a tail footer only exists on success); error frames follow the failure kind (plain exits and non-shell tools error, timeouts/signals/aborts/terminations warn). Unmeasured rows show no footer; bash/powershell native timing stays muted.

## 0.2.2

### Patch Changes

- 03de3b9: The highlight cache key now carries the code's length plus its FNV-1a hash instead of the full source text, shrinking full-cache key memory from megabytes to kilobytes.
- ccf96b7: Extract the grammar-state seed lifecycle into `theme/seed.ts` (language gate, last-hunk slice rule, character cap, shared grammar-state cache, edit/write seed sources) and language detection into `theme/language.ts`. No behavior change: `highlight.ts` keeps re-exports so existing importers work.
- 3b3292c: Resizing across the split/unified threshold no longer re-slices a diff's grammar seed: the seed now covers the diff's last hunk outright instead of the visible window's end, so narrow and wide renders share one seed and one set of highlight cache keys.
- 065dffc: Multi-hunk diffs with grammar seeds (vue/svelte/…) settle noticeably faster: the seed's grammar state is now computed once and shared by every hunk block instead of being re-tokenized per block.
- 59a1fdf: Token-to-ANSI rendering now caches the open/close escape pair per distinct color+fontStyle combination instead of parsing hex and rebuilding strings per token.
- 9099cb9: Unify the visible-window slicing for the unified and split diff views in `render/visible-sources.ts` (`unifiedWindow`/`splitWindow`: window slice plus aligned highlight sources in one return). No behavior change: both views consume the same aligned pairs they hand-built before.
- 58cc52f: Vue files with `<script lang="tsx">` (or any other embedded language) no longer render diff hunks uncolored: the highlighter now loads the embedded grammars the code actually references, guessed from the hunk and its seed text.

## 0.2.1

### Patch Changes

- 35dfbae: The write create preview no longer leaves pale trailing bars on tab-indented rows: tabs now expand to the same width the terminal renderer uses before wrapping.
- c5517ad: The Took footer now reads the same whichever renderer painted the row, and pretty-ms is no longer a dependency.

## 0.2.0

### Minor Changes

- b71229c: Third-party extensions can now borrow pi-pigment's rendering instead of racing it for the tool name: `pi-pigment/render-kit` installs the renderers on YOUR tool definitions (`decorate`) and leaves your `execute` untouched, and a zero-dependency publication channel (`globalThis[Symbol.for("pi-pigment.render-kit.v1")]`) serves extensions that must not import the package. Borrowed rendering is contract-tested byte-identical to pi-pigment's own wrappers. See `docs/integrating.md`.

### Patch Changes

- 9eb6889: The styled-text cell walk no longer allocates a record per cell: `forEachCell` visits a cell's span, column count and escape flag as primitives (its generator predecessor yielded one object per cell and measured 3–8x an inlined walk, the allocation being the bulk of it), and each call site slices the cell's text only when it needs it. Measured on the frame paths, per pair of interleaved runs against the previous code: styled-line width measurement ~5x faster, CJK ~2.5x, styled truncation ~2.5x, background injection with emphasis ranges ~1.4x; the plain-ASCII fast paths are untouched.
- 9eb6889: Rows that carry grapheme clusters (combining marks, ZWJ emoji, flags, conjoining jamo, …) are now walked and measured by cluster, using pi-tui's own `visibleWidth`, so widths, wrapping, truncation and word-emphasis highlights match what the renderer draws; lines without cluster-forming code points keep the fast per-code-point path. The gate's code-point tail is derived from the runtime's `Intl.Segmenter` instead of a hand-copied chart — `pnpm run check:risky-tail` re-derives it — and now covers the Hangul jamo Extended-A/B blocks and the Kirat Rai joiners the previous ranges missed.
- b71229c: Session render state is now a per-session value (`RenderSession`) instead of module-level singletons: diff roots, the theme selection, the user-theme environment, and the converted-theme map are resolved once at `session_start` and carried by the session — the four `set*` writes and the ambient reads they fed are gone, and two sessions in one process can no longer leak theme state into each other.

  Pinning that seam surfaced a real rendering bug, fixed here: Shiki keys its theme registry by name, and a created grammar's color map ignores a later same-name `loadTheme` — so two user theme files sharing a stem (a re-edited file, two projects in one process) rendered with the FIRST file's colors while reporting the new ones. File-channel themes now register under a content-distinct name (`stem~fingerprint`), matching the highlight cache's existing key. Bundled, enforced, and patched theme variants were never affected.

- 722c4a8: Tool wrappers now yield to names another extension (or an SDK-passed custom tool) already claimed: before registering, the extension reads pi's merged tool registry and skips any of the seven built-in names whose source is not `builtin`, with a one-line notice per session. A resume/fork re-fire does not yield to the extension's own prior registration. Names claimed after pi-pigment's `session_start` fires keep pi-pigment's wrapper live under pi's load-order merge (the late registration is dropped with a conflict log); factory-time registration, the render kit, or `disabledTools` cover that case. See ADR 0005's addendum and `docs/integrating.md`.

## 0.1.4

### Patch Changes

- ef064a5: Fix the bash wrapper silently dropping pi's shell settings. Registering the pigment bash tool under the same name replaces pi's builtin definition wholesale, execute included, so the wrapper now reads the same `SettingsManager` pi itself uses and passes `commandPrefix`/`shellPath` into `createBashToolDefinition` — a configured shell or command prefix runs again. The read is gated on the project trust pi resolved, matching pi's own manager: an untrusted project's `.pi/settings.json` must not shape the command that runs.
- bafc374: Derive the truncation notices from the SDK's structured `details` instead of pattern-matching the output text. grep/find/ls append the notice as the output's last line and record the same fact in `details`; the wrapper now lifts that line out of the memoized body when a limit flag is set, so `ls` no longer renders the notice as a `└── [500 entries…]` tree row, a bracketed filename stays a path, and the notice never spends the collapse budget — it paints as the warning footer under the affordance line, like pi's native renderers.
- 98d4177: Internal restructuring, no behavior change: the pi extension entry moves out of `src/` to `index.ts` beside it, matching the other extensions in this repo. package.json `exports` and `pi.extensions` point at `./index.ts`, so loading and importing are unchanged.
- 680e42d: Stop persisting the execution timing: the `Took` footers (grep/find/ls, and the error frame) now read the clock pi's shell renderer already keeps in the render state — armed by `renderCall` while the execution is live, fixed by the first settled `renderResult`. Nothing is written into the session for it, so a resumed or exported session shows no duration, matching pi's own renderers. This also removes the one field pi-pigment appended to every tool result (`pigmentElapsedMs`) plus the two bounded maps that backed the thrown-error path.

## 0.1.3

### Patch Changes

- fc37566: bench: the split verdict and settled output-frame repeats are measured for the dedup fixes that follow (baseline: 4.96µs per verdict, 1.77µs per frame).
- 4f3c22c: settled output frames skip rebuilding the discarded placeholder (3.7x per frame), diff renders compute the split verdict once, and the shell path reuses its inert command.
- 90b7a70: test fixtures: one typed mock-component surface, precise render theme/options/ctx seams, and a single memfs vol import path.
- 5482d59: Background injection under diff lines is faster: escape-free lines skip the cell walk entirely, reset-sequence reinjection is a single indexOf pass (moved into the SGR grammar module), and styled rows no longer pay a wasted full-line ASCII scan before the real walk.
- d51d83b: Styled rows carrying OSC-8 file hyperlinks no longer corrupt the link or the row width: the background re-injection scanner and the cell walk now treat OSC sequences as whole units (an "m" inside a URL no longer ends an SGR scan), which also fixes the crash pi's TUI raises when a resumed session renders an over-wide header row.
- 99d19a6: The unified view's plain-text fallback no longer runs jsdiff twice per paired line: the word-diff analysis now carries its change list, and the painter consumes it directly (~1.8× faster on the over-budget fallback path).
- 5189c99: Internal restructuring, no behavior change: a definePreviewTask builder derives a preview task's identity and cache key from one stamp list, absorbing the width-appended and width-neutral key conventions the six wrappers previously hand-copied.
- 5b7d75d: Internal restructuring, no behavior change: the render-shared module is split into single-authority modules (wrap, row-frame, word-diff, split-verdict, inject-bg) with the shared view contract staying in render-shared; renderPlainOutput moves beside its three callers in tool-output.
- ee5a1dd: Edit and write previews now build the grammar seed only for the languages that embed another syntax (vue, html, php, markdown, ...). A TypeScript or Python preview no longer reads the file from disk and tokenizes a whole-file prefix for a seed that cannot change a single token, the read is memoized once per call instead of restat'ed per re-render, and a prefix past 64KB falls back to the unseeded render rather than a tokenize proportional to the file.
- 0bf8801: Streaming tool frames now render plain and color in once at settle: partial updates no longer re-tokenize their growing content (the transient highlight-cache API is gone), every preview derives the gate from the call's pending state, and resize bursts keep the previous frame until the final width renders instead of flashing the placeholder per width step.
- db77dcf: word-diff counting pins its similarity and astral-cell math, and lone surrogates stay consistent across the two code-point counters.
- 3638a7b: The write tool's create-preview stats (line count + content fingerprint) are now memoized by content reference in the render state — renderResult re-runs on every updateDisplay, and settled args are frozen, so each frame paid two full content scans for values that never change within a call.

## 0.1.2

### Patch Changes

- f07cfaf: perf(pigment): preview renders are single-flight with latest-wins, and streaming grep frames no longer pollute the highlight cache.
- 0ba913f: the theme-switch bench measures the real re-render path again (hlBlock API drift), and a shiki engine bench pins the JS-regex vs Oniguruma decision data.
- f367f94: shiki tokenizes through the Oniguruma WASM engine (the canonical TextMate reference): realistic dense source renders 3-6x faster, cold first-tokenize ~3x, and the JS-regex engine's lazy-compile machinery — the grammar-state flake's root-cause carrier — is gone.
- 9b76d09: word highlights no longer bleed into indentation: whitespace jsdiff merges into changed chunks stays out of the word backgrounds.
- e4e719f: word-diff range extraction is ~36% faster: one allocation-free pass per changed chunk replaces the slice-and-recount walks.

## 0.1.1

### Patch Changes

- e4cc351: Benchmark fixes: the styled-wrap case now really wraps; added `fitAnsi` truncation benches.
- 62d543d: Summary chips close with a bare reset: the header row's background is injected, so the chip stopping re-opens of `bgBase` can no longer overpaint the row tail with a stale canvas.
- 959c796: Re-key the palette from theme content instead of theme-object identity: pi swaps the Theme instance behind a constant module proxy, so identity memoization pinned the first theme's palette and kept diff bodies and stats chips stale after a /settings theme switch.
- e5fe995: Plain-ASCII fast paths for `wrapAnsi`, `fitAnsi`, and `expandTabs`; removed unused `stripAnsi`.
- 9438bf0: Extracted the SGR state machine into `SgrState` (in `core/sgr.ts`); `ansiState` is now its batch wrapper. No behavior change.
- 026a746: wrapAnsi tracks SGR state incrementally (`SgrState` + literal-form fast classifier) instead of re-scanning each row at break; removed the now-unused `ansiState`.
- a24ab79: grep/find toolbox lines close fg with channel-scoped resets: the old full reset killed pi's line-level frame canvas from each match onward, exposing the terminal default background.
- 059cdc3: Write preview body background now layers through `injectBg`, the same primitive the diff views use. No visual change.
