# pi-pigment

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
