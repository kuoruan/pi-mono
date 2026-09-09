# pi-pigment

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
