# pi-pigment

## 0.1.3

### Patch Changes

- fc37566: bench: the split verdict and settled output-frame repeats are measured for the dedup fixes that follow (baseline: 4.96µs per verdict, 1.77µs per frame).
- 4f3c22c: settled output frames skip rebuilding the discarded placeholder (3.7x per frame), diff renders compute the split verdict once, and the shell path reuses its inert command.
- 90b7a70: test fixtures: one typed mock-component surface, precise render theme/options/ctx seams, and a single memfs vol import path.
- 5482d59: Background injection under diff lines is faster: escape-free lines skip the cell walk entirely, reset-sequence reinjection is a single indexOf pass (moved into the SGR grammar module), and styled rows no longer pay a wasted full-line ASCII scan before the real walk.
- d51d83b: Styled rows carrying OSC-8 file hyperlinks no longer corrupt the link or the row width: the background re-injection scanner and the cell walk now treat OSC sequences as whole units (an "m" inside a URL no longer ends an SGR scan), which also fixes the crash pi's TUI raises when a resumed session renders an over-wide header row.
- 99d19a6: The unified view's plain-text fallback no longer runs jsdiff twice per paired line: the word-diff analysis now carries its change list, and the painter consumes it directly (~1.8× faster on the over-budget fallback path).
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
