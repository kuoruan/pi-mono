/**
 * The resolved theme: theme + diff-root overrides → every render color. The
 * derivation is pure (`deriveResolvedTheme`); the session owns memoization,
 * the polarity warning, and threading the snapshot into renders
 * (session.ts). Diff-root overrides
 * (ADR 0003) replace the derivation INPUTS: a translucent tint anchors the
 * word slot with the intensity ladder scaling the family, a text root sets
 * the side's line color — the blend family stays internally consistent and
 * `isLight` keeps following the pi theme (read from the theme's own
 * toolSuccessBg). The canvas is never a root (ADR 0006). There are no
 * presets and no environment variables.
 *
 * `resolve(theme)` is the single entry: it re-derives the whole scheme when
 * the theme or the effective roots change and returns the current snapshot.
 * Header backgrounds and diff-body backgrounds read the same snapshot, so
 * they can never diverge. The module's only I/O is the one-shot polarity
 * warning inside resolve — derivation itself is pure (deriveScheme takes
 * the theme, the effective roots, and the polarity; returns the scheme
 * plus its polarity audit), and all mutable state lives in one explicit
 * state object.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RgbColor } from "@earendil-works/pi-tui";

import { bgRgb, fgRgb, mixBg } from "#src/core/ansi.ts";
import {
  isLightRgb,
  parseAnsiRgb,
  parseHexForm,
  parseRootColor,
  tintCanvas,
} from "#src/core/color.ts";
import { SEQ_BG_DEFAULT, SEQ_RESET } from "#src/core/escapes.ts";

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
 * Diff-root overrides — the scheme derivation inputs (ADR 0003): the
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
 * per-polarity variants; the effective roots merge at scheme-derivation
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
 * The single shared shape; header.ts re-exports it as RenderTheme.
 */
export interface RenderTheme {
  /** The theme's registered name (ours-detection reads it; undefined on fakes). */
  readonly name?: string;
  /** Wrap text in the named color's foreground escape. */
  fg(name: ThemeColor, text: string): string;
  /** The named color's foreground escape, or an empty string. */
  getFgAnsi(name: ThemeColor): string;
  /** One of the background slots the scheme reads. */
  getBgAnsi(name: ThemeBgSlot): string;
  /** Wrap text in one of the background slots' escape. */
  bg(name: ThemeBgSlot, text: string): string;
  /** Wrap text in bold. */
  bold(text: string): string;
}

/** The theme bg slots the scheme reads. */
const THEME_BG_KEYS = ["toolSuccessBg", "toolErrorBg", "searchMatchBg"] as const;

/** The theme bg slots the scheme and headers read (SDK `ThemeBg` subset). */
export type ThemeBgSlot = (typeof THEME_BG_KEYS)[number];

/**
 * The resolved scheme snapshot — every ANSI value the renderers consume.
 * Field names coordinate with the DiffRoots config stems through the
 * fg/bg abbreviation family (one pattern, `<fg|bg><Owner>`):
 * `diff.background` → `bgBase`, `added.text` → `fgAdded`, and the
 * ladder slots `line`/`word`/`gutter` → `bgAdded`/`bgAddedWord`/
 * `bgAddedGutter` (mirrored on the removed side).
 */
export interface ResolvedTheme {
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
   * scope). Toolbox output (grep/ls) must use the bare `SEQ_RESET` from
   * core/escapes instead: re-opening bgBase there paints tool rows with the
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

/** Fallback scheme used before the first resolve() and for theme-less contexts. */
export const FALLBACK_THEME: ResolvedTheme = {
  bgAdded: bgRgb(FALLBACK_BG.added),
  bgRemoved: bgRgb(FALLBACK_BG.removed),
  bgAddedWord: bgRgb(FALLBACK_BG.addedWord),
  bgRemovedWord: bgRgb(FALLBACK_BG.removedWord),
  bgAddedGutter: bgRgb(FALLBACK_BG.addedGutter),
  bgRemovedGutter: bgRgb(FALLBACK_BG.removedGutter),
  bgBase: SEQ_BG_DEFAULT,
  // Bare SEQ_RESET (not SEQ_RESET+bgBase like the derived path): bgBase IS the
  // terminal default background, which a bare reset already restores —
  // the explicit [49m re-open would be a byte-level no-op.
  rowReset: SEQ_RESET,
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

/** The theme fg slots the scheme reads (identity + derivation inputs). */
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

/** The memo: the slot values as last read plus the composed key. */
interface ThemeKeyMemo {
  /** Raw slot ANSI values in read order (fg keys then bg keys). */
  parts: string[];
  /** The composed key for those parts. */
  key: string;
}

/**
 * A stable key for the theme's rendered diff-relevant colors. Two themes that
 * render these keys identically are interchangeable as far as the scheme is
 * concerned; any change (theme switch, hot-reloaded theme file) changes the key.
 *
 * CONTENT-verified memo, not identity-only: production passes the constant
 * module Theme proxy, and pi's setTheme swaps the instance BEHIND the proxy —
 * an identity hit alone must never be trusted (it pinned the first theme's
 * scheme forever — the stale-diff-on-theme-switch report). On every call the
 * walk reads all slots as raw ANSI (getFgAnsi/getBgAnsi — the values, no
 * wrapper strings) and compares them against the memo's parts; an identical
 * read returns the stored key with zero string building, any drift rebuilds.
 * Because the comparison covers EVERY slot deriveScheme reads, drift cannot
 * hide. Every slot deriveScheme reads must sit in the reads (a dim-only
 * reload that missed the key kept the old scheme snapshot once before).
 *
 * @param theme - The theme to key.
 * @returns A string unique to the theme's rendered diff colors.
 */
export function themeCacheKey(theme?: RenderTheme): string {
  if (!theme?.fg) return "no-theme";
  const prev = themeKeyMemo.get(theme);
  // One pass reads every slot; the comparison rides on the same pass, so
  // the memo is verified against the FULL content — never a spot-check.
  const parts: string[] = [];
  let index = 0;
  let drifted = prev === undefined;
  const read = (get: () => string, fallback: string): void => {
    let value: string;
    try {
      value = get();
    } catch {
      value = fallback;
    }
    parts.push(value);
    if (prev !== undefined && prev.parts[index] !== value) drifted = true;
    index++;
  };
  for (const key of THEME_FG_KEYS) read(() => theme.getFgAnsi(key), key);
  for (const key of THEME_BG_KEYS) read(() => theme.getBgAnsi(key), key);
  if (prev !== undefined && !drifted) return prev.key;
  const key = parts.join("|");
  themeKeyMemo.set(theme, { parts, key });
  return key;
}

/** Content-verified memo for themeCacheKey (stable proxy key, content-checked value). */
const themeKeyMemo = new WeakMap<RenderTheme, ThemeKeyMemo>();

// ---------------------------------------------------------------------------
// Derivation (pure)
// ---------------------------------------------------------------------------

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
 * The pure scheme derivation the seam calls per frame: theme + roots →
 * snapshot. No memo, no warning I/O — the session (session.ts) owns
 * both. The snapshot identity (theme content + roots) is recomputed here,
 * so every snapshot is self-describing and comparable.
 *
 * @param theme - The active pi theme (undefined or unreadable → the fallback scheme).
 * @param rootsSpec - The session's diff-root spec.
 * @returns The snapshot and its polarity audit.
 */
export function deriveResolvedTheme(
  theme: RenderTheme | undefined,
  rootsSpec: DiffRootsSpec | undefined,
): DerivedScheme {
  if (!theme?.getFgAnsi) return { scheme: FALLBACK_THEME, polarityOffenders: [] };
  const isLight = deriveIsLight(theme);
  const roots = effectiveRoots(rootsSpec, isLight);
  const identity = [themeCacheKey(theme), rootsKey(rootsSpec)].join("\0");
  return deriveScheme(theme, roots, isLight, identity);
}

/**
 * The one-shot polarity warning's exact text.
 *
 * @param offenders - The contradicting root slots.
 * @returns The full warning line.
 */
export function polarityWarning(offenders: ReadonlyArray<PolarityOffense>): string {
  return (
    `[pi-pigment] diff root override(s) ${offenders.join(", ")} contradict ` +
    `the pi theme's polarity — WCAG enforcement assumes a consistent palette.`
  );
}

/**
 * Whether the pi theme's own toolSuccessBg reads as light (never the
 * override): the polarity anchor for syntax-theme selection.
 *
 * @param theme - The pi theme.
 * @returns True when the theme's own surface is light.
 */
function deriveIsLight(theme: RenderTheme): boolean {
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
 * theme's polarity — enforcement direction assumes a consistent scheme
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
  theme: RenderTheme,
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
        const rgb = tintCanvas(tintRoot.rgb, canvas, tintRoot.alpha);
        if (isLightRgb(rgb) !== isLight) offenders.push(`${side}.tint`);
      }
    }
  }
  return offenders;
}

/** A background override or tint root contradicting the theme's polarity (ADR 0002). */
type PolarityOffense = "background" | `${DiffSide}.tint`;

/** The pure derivation result: the scheme plus its polarity audit. */
interface DerivedScheme {
  /** The derived scheme. */
  scheme: ResolvedTheme;
  /** Background-root overrides contradicting the theme's polarity (ADR 0002). */
  polarityOffenders: PolarityOffense[];
}

/**
 * Derive the full scheme from a theme and the effective diff roots — pure
 * (no I/O; the session owns the one-shot polarity report). Roots replace the
 * derivation inputs
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
 * @returns The derived scheme and its polarity audit.
 */
function deriveScheme(
  theme: RenderTheme,
  roots: DiffRoots,
  isLight: boolean,
  identity: string,
): DerivedScheme {
  // Polarity reads the pi theme's OWN background — never the override.
  const offenders = polarityOffenders(roots, theme, isLight);

  // Foregrounds: theme colors when present, roots override, fallbacks last.
  // Only OPAQUE foreground roots are meaningful (a fg is never composited).
  let fgAdded = FALLBACK_THEME.fgAdded;
  let fgRemoved = FALLBACK_THEME.fgRemoved;
  let fgDim = FALLBACK_THEME.fgDim;
  let fgGutter = FALLBACK_THEME.fgGutter;
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
  let bgBase = SEQ_BG_DEFAULT;
  let reset = SEQ_RESET;
  let bgAdded = FALLBACK_THEME.bgAdded;
  let bgRemoved = FALLBACK_THEME.bgRemoved;
  let bgAddedWord = FALLBACK_THEME.bgAddedWord;
  let bgRemovedWord = FALLBACK_THEME.bgRemovedWord;
  let bgAddedGutter = FALLBACK_THEME.bgAddedGutter;
  let bgRemovedGutter = FALLBACK_THEME.bgRemovedGutter;

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
      reset = `${SEQ_RESET}${bgBase}`;
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
    scheme: {
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
