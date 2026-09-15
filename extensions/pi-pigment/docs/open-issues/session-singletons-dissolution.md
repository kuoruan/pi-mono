# Resolved: session-level singletons (setDiffRoots / setSyntaxThemeSelection / setUserThemeEnv) — dissolved into the session seam (session.ts)

> **Status: DONE (this change).** The open issue below is kept for its analysis
> record. Two of its triggers had in fact fired: #3 (`ToolServices` was
> growing a session-resolved field anyway — the render seam), and #1 in a
> cross-session form (two sessions in one process could pollute each other's
> theme resolution; pinning the acceptance test surfaced it, see below).
> What shipped differs from the sketch below in shape but not in substance:
> the session state is a VALUE (`createRenderSession`), not three setters on
> ToolServices.

## What actually happened

- `src/render/session.ts` is the seam: immutable per-session inputs
  (diff roots, theme selection, user-theme env, collected conversions) plus
  a per-frame binder (`forTheme(theme)` → `RenderView` with `palette`,
  `activeTheme()`, `highlight()`).
- The three setters are gone, along with `resolveDiffPalette`,
  `currentPalette`/`currentTheme`, `resetPaletteForTest`,
  `resetSyntaxThemeForTest`, the converted-theme registry Map, and the
  ambient user-theme env. `deriveDiffPalette`,
  `resolveActiveThemeMemoized` (explicit-memo form), and
  `registeredSourceOf(name, converted)` are pure functions now.
- `resetPigmentForTest` shrank to the highlight-cache clear exactly as
  predicted (the one legitimate memo); the session memos are per-INSTANCE
  state — cross-session pollution is structurally impossible, and the
  acceptance tests pin it (tests/render/session.test.ts, identity
  completeness).
- A real latent bug surfaced while pinning the seam: shiki keys its theme
  registry by NAME and a created grammar's color map does not follow a
  later same-name `loadTheme` — a same-stem user file edited between
  sessions re-tokenized under the OLD color map. File-channel themes now
  register under a content-distinct name (`stem~fingerprint`), the same
  identity the highlight cache already keyed on. (A user theme file
  deleted MID-session still degrades to the derived path — pinned in
  detection-chain.test.ts.)

## The seam today

Three module-level mutable globals carry session state into the render path:

- `setDiffRoots` (src/theme/palette.ts) — the effective diff roots, written at session_start, read ambiently by the palette singleton's derivation.
- `setSyntaxThemeSelection` (src/theme/theme-selection.ts) — the resolved `syntaxTheme` config, read deep in the theme stack (`hlBlock` → `resolveActiveTheme`).
- `setUserThemeEnv` (src/theme/user-themes.ts) — the `{cwd, agentDir}` pair custom-theme discovery reads.

All three are written once per session_start in extension.ts and read during renders. The derive inputs being ambient forces tests/fixtures.ts to aggregate `resetPigmentForTest` (four reset seams: theme-selection memos, palette snapshot, session roots, highlight cache); ~12 test files must remember to call it — a forgotten call is cross-suite pollution.

## The proposed direction (when triggered)

Thread the resolved selection/roots through the existing ToolServices seam:

- `resolveDiffPalette(theme, roots)` and `resolveActiveTheme(...)` become pure functions of explicit inputs.
- The three setters — and three of the four reset seams — dissolve with the singletons. (`clearHighlightCacheForTest` survives: the highlight cache is a legitimate memo, not ambient config, so `resetPigmentForTest` itself shrinks but does not die.)

## Why this was deferred, not done in the first pass

- The explicit-snapshot discipline (CONTEXT.md: "nobody re-reads the singleton mid-render" — wrappers pass `resolveDiffPalette`'s return value down) already confines the ambient-read risk to the derivation inputs. No known bug has been attributed to these reads.
- The threading cost concentrates in the theme stack's depth: `hlBlock` reads the selection far below the wrapper that knows it. Making it a parameter means changing `hlBlock`'s interface, every caller, and the highlight cache key — a wide seam for a hypothetical payoff.
- ADR 0006 does not mandate the singletons; it also does not forbid them.

## Trigger conditions (any one) — all historical now

1. A bug whose root cause is an ambient read of these globals (a stale selection after fork/resume, a cross-session root leak in a restored session).
2. A feature that needs renders to differ within one session on inputs the singletons cannot carry (e.g. per-tool-call palette overrides).
3. ToolServices grows another session-resolved field anyway — the marginal cost of folding these three in drops to near zero.

## Caveat for whoever picks this up

Do not credit this refactor with fixing the grammar-state flake (docs/open-issues/grammar-state-flake.md): that is an upstream engine bug (oniguruma-to-es tokenize nondeterminism), and cross-file roots pollution was already ruled out as its cause. Also note `tests/theme/shiki-engine.bench.ts` binds a raw source import against module layout — move it with the files if the theme modules are regrouped.
