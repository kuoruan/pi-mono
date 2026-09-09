# 0003 — Color naming conventions

Status: **Accepted**

pi-pigment's color naming follows a two-layer convention: the user-facing layer aligns with the ecosystem our theme files belong to (VS Code's), the internal layer follows one private grammar. This ADR is the normative record.

## Survey: what the community does

- **VS Code theme colors** are the de facto standard for TextMate-format
  themes — which is exactly what our `themes/` files are. Measured across the 65 Shiki bundled themes (66 files including the barrel index): `diffEditor.insertedTextBackground` appears in 57, `removedTextBackground` in 52, `diffEditor.insertedLineBackground`/`removedLineBackground` in 15 (github×5, catppuccin×4, rose-pine×3, tokyo-night, plastic), and `editorGutter.addedBackground` in 53. `dark-plus` carries no diff keys.
- **VS Code's diff model has BOTH a word key and a line key**:
  `insertedTextBackground` is the **word-level** tint (mirroring GitHub Primer's `additionWord-bgColor`); `insertedLineBackground` is the **line-level** tint (mirroring `additionLine-bgColor`). VS Code has no diff foreground keys and no context-line colors.
- **GitHub Primer** has first-class word-level tokens:
  `--diffBlob-additionWord-bgColor` / `deletionWord-bgColor`, alongside `additionLine-bgColor` and `additionNum-bgColor` — a Line/Word/Num granularity ladder isomorphic to our line/word/gutter blend family. GitHub's own values use a 2:1 line:word alpha ratio, matching our intensity ladder (0.15 : 0.30).
- **Git** (`color.diff.*`) is the oldest convention: `old`/`new` lines,
  but `context` — our context-line field's term comes from here (and from pi's own `toolDiffContext` slot).
- The core terminology axis is _not_ unified anywhere: VS Code mixes
  `inserted/removed` (diffEditor) with `added/deleted` (editorGutter); Git uses `old/new`; GitHub's UI uses `added/removed`. There is no single canonical vocabulary — but there is one ecosystem with real leverage: VS Code's, because our theme files are its artifacts.

## Decision: a two-layer convention

### External layer — pi-vocabulary, nested by side (user-facing)

The `diff` roots split by LEVEL:

- a box-level `background` (opaque, 6-digit - replaces the shared blend canvas: box bottom, context lines, separators; both sides' ladders wash over it)
- per-side objects - `added`/`removed` (pi's own `toolDiffAdded`/`toolDiffRemoved` slots, which the palette already reads for fg defaults) - with line-scoped `text`/`tint` slots inside: `{ "background": "#332f42", "added": { "text": "#e0e0e8", "tint": "#332f42cc" } }`

The key IS the semantics: `text` is the side's line text color (opaque, 6-digit — pi's own foreground slot is `text`), `tint` (translucent, 8-digit) anchors the word slot and scales the ladder — no format-driven dual behavior, a misplaced form fails at load (later extended: the CSS shorthands `#rgb` / `#rgba`, expanded by TinyColor, joined their respective slots). `background` + `tint` compose (the tint anchors over the custom canvas). The text slots have no VS Code counterpart (diff surfaces there carry no fg keys); VS Code's own long spellings survive only as the passthrough source keys below. Roots are accepted in the `syntaxTheme` object (top level and inside `light`/`dark` variants) and theme files' `"diff"` extension key, with per-slot merges (a variant wins per key, never per side object).

**Canvas adoption (pre-release revision; superseded at generation time by ADR 0006).** A selected theme owns its canvas: a family, a theme file, or a file pair adopts the theme's own `editor.background` as an implicit `background` root at the theme's layer in the roots layering (per polarity for families and pairs — the light variant's canvas on the light side, the dark variant's on the dark side; the missing side of a single-polarity family adopts nothing).

- `auto` adopts nothing — the pi theme owns its canvas there, keeping the diff box harmonious with the terminal it sits in.
- Precedence is the existing layering: the user's `diff.background` root at any higher layer wins per key, and a theme file's explicit `diff.background` beats its own ambient `editor.background` (author intent outranks the ambient canvas).

The bundled-theme intake is ONE module (`bundled-intake.ts`):

- every Shiki-bundled theme loads lazily by name (subpath exports of `@shikijs/themes`, validated against its static `themeNames` registry), imported once per session (module cache, concurrent loads deduped), and materialized idempotently at each consumption — registration name normalized, polarity checked, translucent token colors flattened
- the three consumers (family canvas adoption at session time, direct-name selection, and the render-time family enforcement) share this one path, so a shiki upgrade moves everything automatically and a session that selects nothing bundled pays zero theme loading
- the resolution chain is async at session_start (pi's extension runner awaits every handler's promise)
- theme objects reuse shiki's own `ThemeRegistration` type (the subpath modules declare it); the intake's output narrows it to the materialized form (`name`/`type` settled)

Shiki ships mostly 6-digit backgrounds but 3-digit shorthand exists — github-light's `#fff` — so adoption normalizes shorthand to the roots' 6-digit contract, identically through every channel. With adoption, the two selection channels compose into one ownership model: family = the theme's canvas + AA-enforced colors (our readability guarantee); theme file = the theme's canvas + verbatim colors (the authenticity channel — low-contrast aesthetics like solarized's render exactly as authored); auto = the pi theme owns both. Direct bundled-theme names (any of Shiki's bundle, validated against @shikijs/themes' static `themeNames` and lazily imported per reference — the resolution chain is async at session_start, which pi's runner awaits) resolve as virtual theme files: the file channel's semantics, zero filesystem.

> **ADR 0006 supersession**: runtime canvas adoption dissolved — the converter now puts each theme's `editor.background` into the registered pi theme's background slots at generation time (`toolPendingBg` = `toolSuccessBg` = the exact canvas, zero state-shift jump), and the diff box renders on the pi theme's slots like every other surface. The runtime adoption family (adopted canvas extraction, family/variant canvas specs, ambient-background layering) is deleted, and in a later revision the `diff.background` root itself was removed: the canvas is the pi theme's own, with no override path anywhere (if the canvas doesn't work, pick another theme). The roots keep only the line-scoped `text`/`tint` sides; this document survives as the historical record of the slot-naming decision (the key-is-the-semantics rule still holds for them).

**Free passthrough.** When a theme file's `colors` dict carries `diffEditor.insertedTextBackground` / `removedTextBackground`, those values become the `added.tint` / `removed.tint` roots automatically - no `diff` key needed. A user dropping an existing VS Code theme into `themes/` gets diff colors zero-config.

- The passthrough reads **only these two keys** and only their tint forms — `#rrggbbaa`, or the `#rgba` shorthand (VS Code documents both as "must not be opaque" — an opaque value is dropped with an issue).
- All other VS Code diff keys (line-level, gutter, border, move) are deliberately ignored - the blend family stays derived (ADR 0002: roots, not outputs).

Precedence: the explicit `diff` key wins per slot over the passthrough. Passthrough applies per side (a theme may carry only the inserted key).

**Root value semantics — the key decides.** A `background` value is opaque `#RRGGBB`; a `tint` value is translucent `#RRGGBBAA`:

- An **opaque background** replaces the shared blend canvas — exactly
  today's ADR 0002 contract (`bgBase` ← `toolSuccessBg`).
- A **translucent tint anchors the word slot** and the intensity ladder
  scales the family: the tint's hue becomes the mix accent and its alpha anchors the word-level intensity, so `bgAddedWord = mix(canvas, tint, α)`, `bgAdded = mix(canvas, tint, α·(0.15/0.30))`, `bgAddedGutter = mix(canvas, tint, α·(0.10/0.30))` (the removed side analogously with its own ladder). `mixBg` at intensity α **is** alpha compositing — no new primitive; the author's word-level intent lands exactly, and the line level lands at the author's line intent whenever their line:word ratio matches our 2:1 ladder (it does for the github family: word 30%, line 15%). **The canvas — and therefore `bgBase`, context lines, separators, and padding — stays untouched by tints.**

By default each side composites over **its own** canvas (add → the pi theme's `toolSuccessBg`; removed → the theme's error-box canvas), consistent with the non-passthrough derivation family. A `background` root unifies the canvas for both sides (one key, one surface). When the canvas is missing or unparseable, the tint composites over black `{0,0,0}` (the existing `addBase` default).

The passthrough is **always tint semantics** (its values come from VS Code's tint keys — the source is the intent; the tint forms translate: `#rrggbbaa` / `#rgba`). A translucent **text** root is meaningless (foregrounds are never composited); it fails validation with an issue.

Residual fidelity notes, accepted deliberately: authors whose line:word ratio differs from 2:1 (catppuccin's 4:3) get our ladder anchored at their word value — family consistency wins; the diff **foreground** stays pi's `toolDiffAdded`/`toolDiffRemoved` (VS Code defines no diff fg, and deriving fg from a tint hue is cleverness without user intent).

**Validation.** The config schema widens hex validation **only for root keys** (`isRootHex`, the single home in palette.ts: `text` takes the opaque forms `#rrggbb`/`#rgb`, `tint` the alpha-carrying forms `#rrggbbaa`/`#rgba`; parsing and shorthand expansion are TinyColor's, through `parseHexForm`) — the semantic `colors` keys keep the opaque 6-digit form (`isOpaqueHex6`; a translucent syntax color is meaningless). Theme files' `diff` keys validate through the same slot predicate: unknown keys produce an issue. The polarity-contradiction warning judges the **composited** word-level color (not the raw tint), so translucent roots cannot produce false warnings.

### Internal layer — one grammar (DiffPalette)

Role prefix, semantic stem, qualifier suffix. The stem axis is `add`/`del`/`context`; `context` is spelled out because `ctx` is the codebase's dominant abbreviation for the **render context** — a collision that misreads. The line types in `core/diff.ts` keep `"ctx"` as their closed enum discriminator (unambiguous in `line.type === "ctx"` position); the palette grammar carries the documented exception.

The fields follow one pattern, `<fg|bg><Owner>` (the abbreviation family pi itself uses — `toolSuccessBg` carries a `Bg` suffix, fg slots take semantic names): `bgAdded`/`bgRemoved` (line backgrounds), `bgAddedWord`/`bgRemovedWord` (word-emphasis backgrounds, Primer's vocabulary), `bgAddedGutter`/`bgRemovedGutter` (gutter backgrounds), `bgBase`, `rowReset` (the row-span reset; renamed from `reset` to say the scope), `fgAdded`/`fgRemoved` (diff foregrounds), `fgCode` (code-file type color for ls/find — its own slot, defaulting to the `fgAdded` derivation, so a diff root override restyles diffs without silently restyling file listings), `fgContext` (git `color.diff.context` + pi `toolDiffContext`), `fgDim`, `fgGutter`, `isLight`.

**Abbreviation rule:** expand cryptic abbreviations (`Word`, `reset`); keep only domain-standard, collision-free ones — `add`, `del`, and `lnum` (the standard line-number abbreviation) qualify; `ctx` does not (it is the codebase's abbreviation for the render context, a collision).

The internal layer is private implementation; it optimizes for brevity at ~139 read sites, not for ecosystem familiarity. The external layer carries the compatibility burden.

## Implementation notes

- Root **extraction** (the `diff` key and the `colors` passthrough) lives
  in `loadThemeFile` — session time, raw values only. **Compositing and ladder scaling live in `derivePalette`** — they need the pi theme's canvas, which only exists at derivation time. `setDiffRoots` stores the spec; the roots key keeps the raw serialized values.
- The nested `DiffRoots` shape (sides × slots) plus the slot predicate (`isRootHex`) drive both intakes — the zod schema and the theme-file extractor derive their sides, slots, and hex forms from the one shape, so the config surface and the type stay in lockstep mechanically.

## Breaking changes

- Invalid root keys fail loudly but gently: the zod error triggers the single-key fallback — `syntaxTheme` falls back to `"auto"` with a stderr issue, and **the other config keys (e.g. `disabledTools`) survive**.
- Theme files' unknown `diff` keys produce an issue.
- Theme files whose `colors` dict carries VS Code diff keys render diff colors from those keys (not the pi-derived defaults).

## Consequences

- ADR 0002's "Diff roots, not outputs" principle stands; its key spellings are superseded by this ADR. The tint-anchored family is still derived output — the root pins one anchor (the word slot), never the siblings.
- The passthrough anchor key (`diffEditor.insertedTextBackground`, VS Code's word-level key) anchors the word-level slot `added.bg`: source and behavior agree.

> **Design note (shape provenance)**: the final shape was settled by a full community survey (git `color.diff.*`, delta `plus-*`, VS Code `diffEditor.*`, Primer `diffBlob-*`, shiki's `fg`/`bg`, pi's own `text`/`toolSuccessBg` slots) before first release: the split-by-key rule replaces a format-driven dual behavior that had zero community precedent and failed silently; the box-level `background` was hoisted out of the sides because the canvas affects the whole box (shiki's `bg` and pi's `toolSuccessBg` are the same concept at the same container level). The internal DiffPalette fields coordinate with these stems through one pattern, `<fg|bg><Owner>` (`fgAdded`/`bgAdded`/`bgAddedWord`/`bgAddedGutter`/`fgRemoved`/…/`bgBase` — shared with the chrome fields `fgDim`/`fgGutter`/`fgCode`/`fgContext`), so the future direct-slot tier (`line`/`word`/`gutter`, Primer stems, direct-wins-over-ladder) composes naturally. Survey counts in the Context section were measured against the Shiki version pinned at decision time and drift with upgrades.
