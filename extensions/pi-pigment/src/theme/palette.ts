/**
 * The diff palette — one module singleton, resolved per pi theme and diff-root
 * overrides. The derivation path is auto-derive: add/context surfaces blend
 * the theme's `toolDiffAdded` foreground into its `toolSuccessBg`; removed
 * surfaces blend `toolDiffRemoved` into `toolErrorBg`. Diff-root overrides
 * (ADR 0003) replace the derivation INPUTS: a translucent tint anchors the
 * word slot with the intensity ladder scaling the family, a text root sets
 * the side's line color — the blend family stays internally consistent and
 * `isLight` keeps following the pi theme (read from the theme's own
 * toolSuccessBg). The canvas is never a root (ADR 0006). There are no
 * presets and no environment variables.
 *
 * `resolve(theme)` is the single entry: it re-derives the whole palette when
 * the theme or the effective roots change and returns the current snapshot.
 * Header backgrounds and diff-body backgrounds read the same snapshot, so
 * they can never diverge. The module's only I/O is the one-shot polarity
 * warning inside resolve — derivation itself is pure (derivePalette takes
 * the theme, the effective roots, and the polarity; returns the palette
 * plus its polarity audit), and all mutable state lives in one explicit
 * state object.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RgbColor } from "@earendil-works/pi-tui";

import { BG_DEFAULT, bgRgb, fgRgb, mixBg } from "#src/core/ansi.ts";
import { isLightRgb, parseAnsiRgb, parseHexForm, parseRootColor } from "#src/core/color.ts";

/** The diff sides, in stable order (drives iteration and root identity). */
export const DIFF_SIDES = ["added", "removed"] as const;

/** A diff side (pi's toolDiffAdded/toolDiffRemoved vocabulary). */
export type DiffSide = (typeof DIFF_SIDES)[number];

/**
 * One side's root slots (ADR 0003) — line-scoped effects only. Keys ARE
 * the semantics: `text` is the side's line text color, `tint` anchors the
 * tint ladder (the word-level wash; line/gutter scale with its alpha).
 *
 * Future direct slot overrides (line/word/gutter — the community stem,
 * cf. Primer's additionLine/additionWord) would join as a separate tier
 * with direct-wins precedence; not implemented yet.
 */
export interface DiffRootSide {
  /**
   * The side's text-color root: opaque `#rrggbb` (or shorthand `#rgb`) only (pi's own foreground
   * slot is `text`).
   */
  text?: string;
  /**
   * The side's tint root: translucent `#rrggbbaa` (or shorthand `#rgba`)
   * only (anchors the word slot, ladder scales siblings).
   */
  tint?: string;
}

/**
 * Diff-root overrides — the palette derivation inputs (ADR 0003): the
 * line-scoped side slots only. The box canvas is not a root (ADR 0006):
 * it is the pi theme's own `toolSuccessBg` — one canvas concept, no
 * runtime override path.
 */
export interface DiffRoots {
  /** Added-side roots (the toolDiffAdded side). */
  added?: DiffRootSide;
  /** Removed-side roots (the toolDiffRemoved side). */
  removed?: DiffRootSide;
}

/**
 * The hex form a root slot accepts: the single home of "what each slot
 * takes" (ADR 0003's lockstep claim made real) — both intakes (the config
 * schema and the theme-file extractor) derive from this. The key IS the
 * semantics: `text` takes the opaque forms (`#rrggbb`, or the `#rgb`
 * shorthand — alpha has nowhere to live), `tint` takes the alpha-carrying
 * forms (`#rrggbbaa`, or the `#rgba` shorthand) — a misplaced form fails
 * at load, never silently at render. Parsing and expansion are
 * TinyColor's; this predicate only maps the recognized form to the slot.
 *
 * @param slot - The root's slot ("tint" or "text").
 * @param hex - The candidate hex string.
 * @returns Whether the form fits the slot.
 */
export function isRootHex(slot: keyof DiffRootSide, hex: string): boolean {
  const parsed = parseHexForm(hex);
  if (!parsed) return false;
  return slot === "tint" ? parsed.isAlphaForm : !parsed.isAlphaForm;
}

/**
 * The roots spec as stored per session: polarity-shared roots plus
 * per-polarity variants; the effective roots merge at palette-derivation
 * time (variant wins per key).
 */
export interface DiffRootsSpec {
  /** Roots applying to both polarities. */
  topLevel?: DiffRoots;
  /** Roots applying when the pi theme is light. */
  light?: DiffRoots;
  /** Roots applying otherwise. */
  dark?: DiffRoots;
}

/**
 * The minimal theme surface the renderers read — the structural subset of
 * the SDK's Theme class (fg/getFgAnsi/getBgAnsi/bg/bold) that fakes can
 * implement. Slot names reuse the SDK's `ThemeColor` vocabulary (single
 * source of truth); the bg side narrows to the slots we actually read.
 * Every method is REQUIRED: the SDK's Theme class provides them all —
 * optionality here was over-defensiveness that let fixtures drift from
 * the real contract (and forced `?? ""` fallbacks at every read site).
 * The single shared shape; header.ts re-exports it as PaletteTheme.
 */
export interface PaletteTheme {
  /** The theme's registered name (ours-detection reads it; undefined on fakes). */
  readonly name?: string;
  /** Wrap text in the named color's foreground escape. */
  fg(name: ThemeColor, text: string): string;
  /** The named color's foreground escape, or an empty string. */
  getFgAnsi(name: ThemeColor): string;
  /** One of the two background slots the palette reads. */
  getBgAnsi(name: PaletteBgColor): string;
  /** Wrap text in one of the two background slots' escape. */
  bg(name: PaletteBgColor, text: string): string;
  /** Wrap text in bold. */
  bold(text: string): string;
}

/** The theme bg slots the palette reads (canvas + identity). */
const THEME_BG_KEYS = ["toolSuccessBg", "toolErrorBg"] as const;

/** The theme bg slots the palette and headers read (SDK `ThemeBg` subset). */
export type PaletteBgColor = (typeof THEME_BG_KEYS)[number];

/**
 * The resolved palette snapshot — every ANSI value the renderers consume.
 * Field names coordinate with the DiffRoots config stems through the
 * fg/bg abbreviation family (one pattern, `<fg|bg><Owner>`):
 * `diff.background` → `bgBase`, `added.text` → `fgAdded`, and the
 * ladder slots `line`/`word`/`gutter` → `bgAdded`/`bgAddedWord`/
 * `bgAddedGutter` (mirrored on the removed side).
 */
export interface DiffPalette {
  /** Background for added lines. */
  bgAdded: string;
  /** Background for removed lines. */
  bgRemoved: string;
  /** Word-level emphasis background on added lines. */
  bgAddedWord: string;
  /** Word-level emphasis background on removed lines. */
  bgRemovedWord: string;
  /** Gutter background for added lines. */
  bgAddedGutter: string;
  /** Gutter background for removed lines. */
  bgRemovedGutter: string;
  /** Tool-box base background (theme's toolSuccessBg when available). */
  bgBase: string;
  /**
   * Reset that re-opens bgBase — for DIFF ROW spans only (the name says the
   * scope). Toolbox output (grep/ls) must use the bare `RESET` from
   * core/ansi instead: re-opening bgBase there paints tool rows with the
   * diff canvas.
   */
  rowReset: string;
  /** Fallback dim foreground for context text and padding. */
  fgDim: string;
  /** Gutter digits' foreground (the muted slot), pairing bgAddedGutter/bgRemovedGutter. */
  fgGutter: string;
  /** Added-line foreground: the theme's toolDiffAdded, else the fallback. */
  fgAdded: string;
  /**
   * Code-file type color for ls/find listings — its own slot (NOT
   * fgAdded's second job: a diff root override like added.text
   * restyles diffs, not file listings). Defaults to the same derived
   * value as fgAdded so the stock look is unchanged; a future root can
   * retune it independently.
   */
  fgCode: string;
  /** Removed-line foreground: the theme's toolDiffRemoved, else the fallback. */
  fgRemoved: string;
  /** Context foreground: the theme's toolDiffContext, else the dim fallback. */
  fgContext: string;
  /** Whether the theme's surface reads as light (drives the syntax theme). */
  isLight: boolean;
  /**
   * The identity of the inputs that produced this snapshot (the theme's
   * rendered colors + the effective roots). A CACHE KEY, not render data:
   * downstream memos (preview-task keys, active-theme identity) compose
   * from it instead of recomputing themeCacheKey per render.
   */
  identity: string;
}

/** Fallback line backgrounds, tuned for dark tool boxes. */
const FALLBACK_BG: Record<string, RgbColor> = {
  added: { r: 30, g: 52, b: 40 },
  removed: { r: 60, g: 30, b: 30 },
  addedWord: { r: 45, g: 90, b: 60 },
  removedWord: { r: 100, g: 45, b: 45 },
  addedGutter: { r: 24, g: 42, b: 32 },
  removedGutter: { r: 48, g: 28, b: 28 },
} as const;

/** Fallback foregrounds, desaturated for diff surfaces. */
const FALLBACK_FG: Record<string, RgbColor> = {
  added: { r: 100, g: 180, b: 120 },
  removed: { r: 200, g: 100, b: 100 },
  dim: { r: 80, g: 80, b: 80 },
  gutter: { r: 100, g: 100, b: 100 },
} as const;

/** The full reset escape. */
const RESET = "\x1b[0m";

/** Fallback palette used before the first resolve() and for theme-less contexts. */
export const FALLBACK_PALETTE: DiffPalette = {
  bgAdded: bgRgb(FALLBACK_BG.added),
  bgRemoved: bgRgb(FALLBACK_BG.removed),
  bgAddedWord: bgRgb(FALLBACK_BG.addedWord),
  bgRemovedWord: bgRgb(FALLBACK_BG.removedWord),
  bgAddedGutter: bgRgb(FALLBACK_BG.addedGutter),
  bgRemovedGutter: bgRgb(FALLBACK_BG.removedGutter),
  bgBase: BG_DEFAULT,
  // Bare RESET (not RESET+bgBase like the derived path): bgBase IS the
  // terminal default background, which a bare reset already restores —
  // the explicit [49m re-open would be a byte-level no-op.
  rowReset: RESET,
  fgAdded: fgRgb(FALLBACK_FG.added),
  fgCode: fgRgb(FALLBACK_FG.added),
  fgRemoved: fgRgb(FALLBACK_FG.removed),
  fgDim: fgRgb(FALLBACK_FG.dim),
  fgGutter: fgRgb(FALLBACK_FG.gutter),
  fgContext: fgRgb(FALLBACK_FG.dim),
  isLight: false,
  identity: "fallback",
};

// ---------------------------------------------------------------------------
// Theme identity
// ---------------------------------------------------------------------------

/** The theme fg slots the palette reads (identity + derivation inputs). */
const THEME_FG_KEYS = [
  "toolTitle",
  "accent",
  "muted",
  "dim",
  "success",
  "error",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
] as const;

/**
 * A stable key for the theme's rendered diff-relevant colors. Two themes that
 * render these keys identically are interchangeable as far as the palette is
 * concerned; any change (theme switch, hot-reloaded theme file) changes the key.
 *
 * @param theme - The theme to key.
 * @returns A string unique to the theme's rendered diff colors.
 */
export function themeCacheKey(theme?: PaletteTheme): string {
  if (!theme?.fg) return "no-theme";
  // Identity memo keyed on the theme OBJECT: pi's theme switching and
  // hot-reload both replace the instance (loadTheme constructs a new
  // Theme every time — verified), so object identity is change-safe.
  // This walk was once per-resolveDiffPalette (the per-render hot path —
  // "dim" was left out by that era's omission); the identity memo below
  // now runs it once per theme instance, and EVERY slot derivePalette
  // reads must sit in the key arrays — a dim-only hot-reload that missed
  // the key kept silent the old palette snapshot.
  const memoized = themeKeyMemo.get(theme);
  if (memoized !== undefined) return memoized;
  const parts: string[] = [];
  for (const key of THEME_FG_KEYS) {
    try {
      parts.push(theme.fg(key, key));
    } catch {
      parts.push(key);
    }
  }
  for (const key of THEME_BG_KEYS) {
    try {
      if (theme.bg) {
        parts.push(theme.bg(key, key));
      } else if (theme.getBgAnsi) {
        parts.push(theme.getBgAnsi(key));
      } else {
        parts.push(key);
      }
    } catch {
      parts.push(key);
    }
  }
  const key = parts.join("|");
  themeKeyMemo.set(theme, key);
  return key;
}

/** Object-identity memo for themeCacheKey (themes are replaced, never mutated). */
const themeKeyMemo = new WeakMap<PaletteTheme, string>();

// ---------------------------------------------------------------------------
// Singleton state and resolution
// ---------------------------------------------------------------------------

/**
 * The singleton's entire mutable state — one explicit object, mutated only
 * by setDiffRoots, resolveDiffPalette, and resetPaletteForTest. Everything
 * else in this module is pure.
 */
const state = {
  /** The current snapshot (FALLBACK_PALETTE until the first resolve). */
  palette: FALLBACK_PALETTE as DiffPalette,
  /** The memo key (theme identity + roots identity). */
  themeKey: "",
  /** The theme behind the current snapshot. */
  theme: undefined as PaletteTheme | undefined,
  /** The session's diff-root spec (set at session_start; ADR 0002). */
  rootsSpec: undefined as DiffRootsSpec | undefined,
  /** The roots identity in the current memo (topLevel + variants serialized). */
  rootsKey: "",
  /** One-shot polarity-contradiction warning flag (reset by setDiffRoots). */
  warned: false,
};

/**
 * Set the session's diff-root overrides (the `diff` entries of the
 * syntaxTheme selection, including theme-file diff keys).
 *
 * @param spec - The roots spec, or undefined to clear.
 */
export function setDiffRoots(spec: DiffRootsSpec | undefined): void {
  state.rootsSpec = spec;
  state.rootsKey = rootsKey(spec);
  state.warned = false;
  // Force re-derivation on the next resolve: even identical roots must
  // re-run (the one-shot warning flag was reset).
  state.themeKey = "";
}

/**
 * A stable identity for a roots spec.
 *
 * @param spec - The roots spec (possibly undefined).
 * @returns A string unique to its contents.
 */
function rootsKey(spec: DiffRootsSpec | undefined): string {
  if (!spec) return "no-roots";
  return JSON.stringify([spec.topLevel ?? {}, spec.light ?? {}, spec.dark ?? {}]);
}

/**
 * The effective roots for a polarity: top-level overlaid by the variant.
 *
 * @param spec - The session's roots spec.
 * @param isLight - Whether the pi theme reads as light.
 * @returns The merged roots (may be empty).
 */
function effectiveRoots(spec: DiffRootsSpec | undefined, isLight: boolean): DiffRoots {
  if (!spec) return {};
  const variant = isLight ? spec.light : spec.dark;
  return mergeRoots(spec.topLevel, variant);
}

/**
 * Merge two roots objects per level and slot (the second wins per key) —
 * the nested shape's merge depth: a shallow spread would replace a whole
 * side object, dropping the other's slot (top-level added.tint + variant
 * added.fg must coexist).
 *
 * @param a - The base roots (may be undefined).
 * @param b - The overriding roots (may be undefined).
 * @returns The merged roots (empty when both are empty).
 */
function mergeRoots(a: DiffRoots | undefined, b: DiffRoots | undefined): DiffRoots {
  if (!a) return b ?? {};
  if (!b) return a;
  return {
    added: { ...a.added, ...b.added },
    removed: { ...a.removed, ...b.removed },
  };
}

/**
 * The current palette snapshot (refreshed by resolveDiffPalette).
 * Test seam only: production renders receive the palette EXPLICITLY (the
 * wrapper's resolveDiffPalette return value threaded through the pipeline);
 * nothing in src/ reads this — tests use it to inspect the singleton.
 *
 * @returns The last resolved palette.
 */
export function currentPalette(): DiffPalette {
  return state.palette;
}

/**
 * The theme behind the current palette snapshot (undefined until the first
 * resolve, or when the theme was unreadable). Test seam only, same as
 * currentPalette.
 *
 * @returns The last resolved pi theme.
 */
export function currentTheme(): PaletteTheme | undefined {
  return state.theme;
}

/**
 * Resolve the palette for `theme`, re-deriving when the theme changed since
 * the last call. Always returns the current snapshot; safe to call on every
 * render. Falls back to the last snapshot when the theme is unreadable.
 *
 * @param theme - The active pi theme.
 * @returns The resolved palette snapshot.
 */
export function resolveDiffPalette(theme?: PaletteTheme): DiffPalette {
  const key = [themeCacheKey(theme), state.rootsKey].join("\0");
  if (key === state.themeKey) return state.palette;
  state.themeKey = key;
  state.theme = theme;
  if (!theme?.getFgAnsi) {
    state.palette = FALLBACK_PALETTE;
    return state.palette;
  }
  const isLight = deriveIsLight(theme);
  const roots = effectiveRoots(state.rootsSpec, isLight);
  const derived = derivePalette(theme, roots, isLight, key);
  state.palette = derived.palette;
  if (derived.polarityOffenders.length > 0 && !state.warned) {
    // The module's only I/O: one stderr warning per roots set (the
    // session_start issue printing in extension.ts is the other boundary).
    state.warned = true;
    console.error(
      `[pi-pigment] diff root override(s) ${derived.polarityOffenders.join(", ")} contradict ` +
        `the pi theme's polarity — WCAG enforcement assumes a consistent palette.`,
    );
  }
  return state.palette;
}

/** Force re-derivation on the next resolve() (test seam). */
export function resetPaletteForTest(): void {
  state.themeKey = "";
  state.theme = undefined;
}

/**
 * Whether the pi theme's own toolSuccessBg reads as light (never the
 * override): the polarity anchor for syntax-theme selection.
 *
 * @param theme - The pi theme.
 * @returns True when the theme's own surface is light.
 */
function deriveIsLight(theme: PaletteTheme): boolean {
  try {
    const parsed = parseAnsiRgb(theme.getBgAnsi("toolSuccessBg"));
    return parsed ? isLightRgb(parsed) : false;
  } catch {
    return false;
  }
}

/**
 * The opaque RGB of an opaque root value (null for translucent or invalid
 * values — translucent fgs are meaningless, translucent bgs are tints).
 *
 * @param hex - The root hex string.
 * @returns The RGB, or null.
 */
function opaqueRootRgb(hex: string): RgbColor | null {
  const root = parseRootColor(hex);
  return root && root.alpha >= 1 ? root.rgb : null;
}

/**
 * The background-root overrides whose COMPOSITED color contradicts the pi
 * theme's polarity — enforcement direction assumes a consistent palette
 * (ADR 0002). Translucent tints are judged by their composited word-level
 * color (the actual rendered surface), so a tint cannot produce a false
 * warning.
 *
 * @param roots - The effective roots.
 * @param theme - The pi theme (canvas source for tint compositing).
 * @param isLight - The pi theme's own polarity.
 * @returns The contradicting root slots (empty when consistent).
 */
function polarityOffenders(
  roots: DiffRoots,
  theme: PaletteTheme,
  isLight: boolean,
): Array<`${DiffSide}.tint`> {
  const offenders: Array<`${DiffSide}.tint`> = [];
  for (const side of DIFF_SIDES) {
    // tint: judged by its composited word-level color (the actual
    // rendered surface) so a tint cannot produce a false warning.
    const tintHex = roots[side]?.tint;
    if (tintHex) {
      const tintRoot = parseRootColor(tintHex);
      if (tintRoot) {
        // Composite the tint over the side's canvas (black when unparseable).
        let canvas: RgbColor = { r: 0, g: 0, b: 0 };
        try {
          const ansi =
            side === "added" ? theme.getBgAnsi("toolSuccessBg") : theme.getBgAnsi("toolErrorBg");
          canvas = parseAnsiRgb(ansi) ?? canvas;
        } catch {
          // keep black
        }
        const a = tintRoot.alpha;
        const rgb = {
          r: Math.round(tintRoot.rgb.r * a + canvas.r * (1 - a)),
          g: Math.round(tintRoot.rgb.g * a + canvas.g * (1 - a)),
          b: Math.round(tintRoot.rgb.b * a + canvas.b * (1 - a)),
        };
        if (isLightRgb(rgb) !== isLight) offenders.push(`${side}.tint`);
      }
    }
  }
  return offenders;
}

/** The pure derivation result: the palette plus its polarity audit. */
interface DerivedPalette {
  /** The derived palette. */
  palette: DiffPalette;
  /** Background-root overrides contradicting the theme's polarity (ADR 0002). */
  polarityOffenders: Array<"background" | `${DiffSide}.tint`>;
}

/**
 * Derive the full palette from a theme and the effective diff roots — pure
 * (no I/O; resolveDiffPalette owns reporting). Every reader shares this one
 * result through the singleton. Roots replace the derivation inputs
 * (added.text→toolDiffAdded, removed.text→toolDiffRemoved,
 * background→the box canvas (both sides blend over it),
 * the del canvas; translucent roots anchor the word slot per ADR 0003);
 * `isLight` keeps reading the pi theme's OWN toolSuccessBg (ADR 0002 —
 * polarity follows the terminal, not overrides), while background/reset read the
 * effective (possibly overridden) OPAQUE base.
 *
 * @param theme - The theme to derive from.
 * @param roots - The effective diff roots for the theme's polarity.
 * @param isLight - The pi theme's own polarity (never root-derived).
 * @param identity - The cache identity of the inputs (carried on the snapshot).
 * @returns The derived palette and its polarity audit.
 */
function derivePalette(
  theme: PaletteTheme,
  roots: DiffRoots,
  isLight: boolean,
  identity: string,
): DerivedPalette {
  // Polarity reads the pi theme's OWN background — never the override.
  const offenders = polarityOffenders(roots, theme, isLight);

  // Foregrounds: theme colors when present, roots override, fallbacks last.
  // Only OPAQUE foreground roots are meaningful (a fg is never composited).
  let fgAdded = FALLBACK_PALETTE.fgAdded;
  let fgRemoved = FALLBACK_PALETTE.fgRemoved;
  let fgDim = FALLBACK_PALETTE.fgDim;
  let fgGutter = FALLBACK_PALETTE.fgGutter;
  try {
    fgAdded = theme.getFgAnsi("toolDiffAdded") || fgAdded;
    fgRemoved = theme.getFgAnsi("toolDiffRemoved") || fgRemoved;
    // Muted chrome follows the theme's own dim/muted slots (both required
    // in pi's theme schema): separators, more-lines notes, line numbers —
    // a fixed dark gray would wash out on light themes.
    fgDim = theme.getFgAnsi("dim") || fgDim;
    fgGutter = theme.getFgAnsi("muted") || fgGutter;
  } catch {
    // keep fallbacks
  }
  // fgCode snapshots the theme-derived fg BEFORE the root overrides: a
  // diff root restyles diffs, not file listings (the slot's documented
  // isolation — a future root can retune it independently).
  const fgCode = fgAdded;
  if (roots.added?.text) {
    const root = parseRootColor(roots.added.text);
    if (root && root.alpha >= 1) fgAdded = fgRgb(root.rgb);
  }
  if (roots.removed?.text) {
    const root = parseRootColor(roots.removed.text);
    if (root && root.alpha >= 1) fgRemoved = fgRgb(root.rgb);
  }
  // Backgrounds: blend the effective diff fg into the effective tool boxes.
  let bgBase = BG_DEFAULT;
  let reset = RESET;
  let bgAdded = FALLBACK_PALETTE.bgAdded;
  let bgRemoved = FALLBACK_PALETTE.bgRemoved;
  let bgAddedWord = FALLBACK_PALETTE.bgAddedWord;
  let bgRemovedWord = FALLBACK_PALETTE.bgRemovedWord;
  let bgAddedGutter = FALLBACK_PALETTE.bgAddedGutter;
  let bgRemovedGutter = FALLBACK_PALETTE.bgRemovedGutter;

  try {
    const addRgb =
      (roots.added?.text ? opaqueRootRgb(roots.added.text) : null) ??
      parseAnsiRgb(theme.getFgAnsi("toolDiffAdded"));
    const delRgb =
      (roots.removed?.text ? opaqueRootRgb(roots.removed.text) : null) ??
      parseAnsiRgb(theme.getFgAnsi("toolDiffRemoved"));
    if (addRgb && delRgb) {
      let addBase = { r: 0, g: 0, b: 0 };
      let delBase = addBase;
      try {
        const successBgAnsi = theme.getBgAnsi("toolSuccessBg");
        const successParsed = parseAnsiRgb(successBgAnsi);
        if (successParsed) {
          addBase = successParsed;
          delBase = successParsed;
          bgBase = successBgAnsi;
        }
      } catch {
        // keep black base
      }
      try {
        const errorParsed = parseAnsiRgb(theme.getBgAnsi("toolErrorBg"));
        if (errorParsed) delBase = errorParsed;
      } catch {
        // keep success base
      }
      // Root semantics (ADR 0003/0006): the canvas is the pi theme's own
      // toolSuccessBg/toolErrorBg — never a root; the side-level `tint`
      // anchors the word slot and the intensity ladder scales the family.
      const addedTint = roots.added?.tint ? parseRootColor(roots.added.tint) : null;
      const removedTint = roots.removed?.tint ? parseRootColor(roots.removed.tint) : null;
      if (addedTint) {
        // Tint anchoring: mixBg at α IS alpha compositing — the author's
        // word-level intent lands exactly; the ladder scales the siblings.
        const { rgb, alpha } = addedTint;
        bgAddedWord = mixBg(addBase, rgb, alpha);
        bgAdded = mixBg(addBase, rgb, alpha * (0.15 / 0.3));
        bgAddedGutter = mixBg(addBase, rgb, alpha * (0.1 / 0.3));
      } else {
        bgAdded = mixBg(addBase, addRgb, 0.15);
        bgAddedWord = mixBg(addBase, addRgb, 0.3);
        bgAddedGutter = mixBg(addBase, addRgb, 0.1);
      }
      if (removedTint) {
        const { rgb, alpha } = removedTint;
        bgRemovedWord = mixBg(delBase, rgb, alpha);
        bgRemoved = mixBg(delBase, rgb, alpha * (0.18 / 0.35));
        bgRemovedGutter = mixBg(delBase, rgb, alpha * (0.12 / 0.35));
      } else {
        bgRemoved = mixBg(delBase, delRgb, 0.18);
        bgRemovedWord = mixBg(delBase, delRgb, 0.35);
        bgRemovedGutter = mixBg(delBase, delRgb, 0.12);
      }
      reset = `${RESET}${bgBase}`;
    }
  } catch {
    // keep fallback backgrounds
  }

  let fgContext = fgDim;
  try {
    fgContext = theme.getFgAnsi("toolDiffContext") || fgDim;
  } catch {
    // keep dim fallback
  }

  return {
    palette: {
      bgAdded,
      bgRemoved,
      bgAddedWord,
      bgRemovedWord,
      bgAddedGutter,
      bgRemovedGutter,
      bgBase,
      rowReset: reset,
      fgAdded,
      fgCode,
      fgRemoved,
      fgDim,
      fgGutter,
      fgContext,
      isLight,
      identity,
    },
    polarityOffenders: offenders,
  };
}
