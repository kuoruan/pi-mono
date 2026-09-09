# Open issue: grammar-state test flakes under full parallel runs (10-50%)

## Status update: the root-cause carrier left with the engine migration

The shiki engine migration (JS-regex → Oniguruma WASM) removed the flake's identified root-cause carrier from the runtime: `oniguruma-to-es`'s `lazyCompileLength` machinery (emulated long-pattern regexes compiled on first `exec`) no longer exists in the tokenize path — the WASM engine interprets TextMate patterns directly. The `LoadedLangs`/`clip_search` suspects in Leading suspects below are all `oniguruma-to-es` internals; they cannot recur. Post-migration evidence: 5 consecutive full-parallel runs green (562/562 each — the old signature was 10-20% per run). Not marked definitively closed: CI accrual continues, and the in-test self-heal (clear cache + re-render, ≤3 attempts) stays as unrelated defense-in-depth. The guardrails below remain binding regardless.

`tests/render/tool-output.test.ts` → "grep highlights same-file lines as one block (grammar state flows across lines)" fails ~10-20% of **full parallel** runs (`vitest run`, 16 forks), never in isolation, never with `--no-file-parallelism`, and never standalone (same code outside vitest is deterministic). Pre-dates the cleanup rounds (witnessed once during the P/T batches); the cleanup's type/import-only changes are not the trigger.

## Evidence (per-PID instrumented logs, two failure captures)

- The failing frame's tokenize is **self-consistent under one theme** — this is not theme/state pollution: `beta` gets the function color (tagged-template tokenization), `` `;`` the string color. I.e. `codeToTokensBase` tokenized the block **as if it started at `beta`** — the template-string state never opened on line 0.
- Instrumentation proved the **call chain is innocent**: one `renderHighlighted` call, the chunk handed to `hlBlock` contains all lines (`"const s = \`alpha\nbeta\`;\nconst done = 1;\n"`), `highlightCache`MISS, unique themeId,`loadedLangs` normal.
- **Correlated across forks**: in one failing run, three separate test files (one per fork) all produced fragmented tokenizes of the same input simultaneously — then a direct `hlBlock` probe inserted right after the failing test ALSO failed in the same run. Afterward everything self-heals: subsequent tokenizes of the same input are correct.
- **Process-persistent, input-specific corruption**: once a fork tokenizes an input fragmented, the fragmented result sits in `highlightCache` (deterministic key) and every retry re-serves it — `retry: 2` failed all three attempts on the same bad entry (the cache-poisoning confirmation; retry was reverted). The earlier "self-healing" evidence (the `"Get-ChildIte"` truncation followed by a correct render) is RETRACTED — that was a powershell streaming-args partial (renderCall on a mid-stream command), not a corrupted-then-healed tokenize.
- **`fileParallelism: false` is stable** (4× green, ~26s vs ~7s) — the suite ran sequentially until this was rooted upstream. This pin was later REPLACED by an in-test self-heal (see Status below): the whole suite runs parallel again.
- Standalone Node (same code path, same theme, same grammar) is always correct, first call included. Concurrent `codeToTokensBase` (same or different grammar) in one process could not reproduce it either.
- `oniguruma-to-es`'s `envFlags` feature detection is identical inside vitest forks and standalone (target ES2024 both); `RegExp` unpatched.
- **Vite transformation ruled out**: forcing shiki/oniguruma-to-es external (native Node ESM) still flakes 5/8.
- **Cross-file roots pollution ruled out**: the flake-run themeId (41fcc1e4) equals the clean-run one, and `palette.identity` hashes the roots — leftover roots from another file would change the id.
- `fileParallelism: false` (config'd) is the stable stopgap.

## Leading suspects

1. `oniguruma-to-es` **lazy compilation** (`lazyCompileLength: 3e3`: patterns ≥3000 chars construct as empty-source regexes, compiled on first `exec`) interacting with something in the vitest fork environment.
2. `EmulatedRegExp`'s `clip_search` strategy (executes against `str.slice(lastIndex)`) under an as-yet-unidentified state divergence.
3. Some vitest-module-runner behavior for externalized deps under load.

## Guardrails for future work

- `corePromise` (the shiki core singleton) must NEVER gain a test reset: it is this flake's root-cause carrier and the one state whose only isolation boundary is the process. `resetPigmentForTest` in the fixtures deliberately stops short of it.
- The highlight-cache reset seam (`clearHighlightCacheForTest`) exists so a future "clear cache + retry" mitigation is at least _possible_ — but see Next steps: re-tokenize recovery is unproven.

## Next steps

0. ~~Verify clear-cache + re-tokenize recovery~~ — DONE: the flaky test now self-heals: each attempt clears the cache (`resetPigmentForTest`) and rebuilds the component from scratch; a poisoned first render re-tokenizes, and up to two re-renders run before the assertions fail. The suite returned to full parallelism (the global pin is gone); the recovery claim is being watched in CI runs.
1. **File the upstream issue** (shiki / @shikijs/engine-javascript) with the two token-dump signatures (no-match type: whole-line plain token; and wrong-match type: template-string state never opening) — ask whether first-use `codeToTokensBase` has known nondeterminism under child-process forks.
2. Cache-clear + retry is NOT viable until "a re-tokenize of the same input in the same corrupted process recovers" is verified — the retracted self-heal evidence leaves that unproven.
3. Two failure signatures to keep separated in any report (they may be two root causes): **no-match** (fork 305651: rules never fire, whole-line plain) vs **wrong-match** (305674: template state never opens, `beta` tokenizes as a tagged-template tag; 305685's truncated token).
