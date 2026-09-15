/**
 * Render-time theme interpretation — THE single home for "how a resolved
 * selection becomes the colors you see": the ADR 0002 semantics (polarity
 * gating, patches continuing onto auto, the AA boundary — bundled names
 * enforce, user files verbatim). Session-time discovery lives in
 * theme-resolver; this module interprets its product at render time,
 * memoized per identity.
 */

import type { BundledTheme } from "shiki";

import { createBoundedMap, type BoundedMap } from "#src/core/bounded-map.ts";
import type { SessionEnv } from "#src/core/session-env.ts";

import { loadBundledTheme } from "./bundled-intake.ts";
import { themeCacheKey, type DiffPalette, type PaletteTheme } from "./palette.ts";
import {
  aaCheckBackgrounds,
  applySemanticPatches,
  buildPiSyntaxTheme,
  buildSemanticTheme,
  enforceThemeColors,
  SEMANTIC_TO_PI,
  type SemanticColors,
  type ShikiThemeInput,
} from "./syntax-theme.ts";
import type { LoadedThemeFile } from "./theme-file.ts";
import { registeredSourceOf, type ConvertedTheme } from "./theme-registry.ts";
import type { ThemeSelection } from "./theme-resolver.ts";
import { loadUserTheme } from "./user-themes.ts";

/**
 * The session's render-time theme inputs — the selection plus everything
 * ours-detection and the user-file load need. The resolution is a pure
 * function of these; the session value carries them (session.ts).
 */
export interface ThemeResolveInputs {
  /** The resolved selection. */
  selection: ThemeSelection;
  /** The collected user conversions (ours-detection's user half). */
  convertedThemes: ReadonlyArray<ConvertedTheme>;
  /** The environment user-file loads read. */
  themeEnv: SessionEnv;
}

/** The active-theme memo: identity key → resolved theme promise. */
export type ActiveThemeMemo = BoundedMap<string, Promise<ShikiThemeInput | null>>;

/**
 * The selection's serialized form — memoized per object (file/object
 * selections embed whole theme objects, and the identity runs per block).
 * WeakMap-keyed: the resolver hands a fresh selection object each
 * session_start, so a changed selection is always a new key.
 */
const selectionFingerprints = new WeakMap<ThemeSelection, string>();

/**
 * The serialized form of a selection, computed once per object.
 *
 * @param target - The selection.
 * @returns Its stable fingerprint.
 */
function fingerprintOf(target: ThemeSelection): string {
  let fingerprint = selectionFingerprints.get(target);
  if (fingerprint === undefined) {
    fingerprint = JSON.stringify(target);
    selectionFingerprints.set(target, fingerprint);
  }
  return fingerprint;
}

/**
 * The identity the active-theme memo keys on: the selection, the pi theme
 * (name included — the ours-detection input), the palette roots
 * (backgrounds) — every input that changes the output.
 *
 * @param inputs - The session's render-time theme inputs.
 * @param palette - The resolved palette (backgrounds drive enforcement).
 * @param theme - The pi theme (its name drives ours-detection).
 * @returns A string unique to the resolution inputs.
 */
function activeThemeIdentity(
  inputs: ThemeResolveInputs,
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
): string {
  // The background key carries ALL four blend backgrounds — the same key
  // enforceLoadedFile caches on — so identity and enforcement can never
  // disagree about which backgrounds a resolution saw (bgAdded/bgRemoved alone
  // happen to determine the word roots, but only by derivation). The
  // palette's own identity (theme + roots, computed once at derivation)
  // covers its 8 fg + 2 bg slots; the nine syntax* colors ride separately —
  // a hot-reloaded custom pi theme can keep its name while changing only
  // those (the live-proxy theme object is replaced in place), and the
  // follower path derives from exactly them.
  const syntaxColors = Object.values(SEMANTIC_TO_PI)
    .map((slot) => theme?.getFgAnsi(slot) ?? "")
    .join(",");
  return [
    fingerprintOf(inputs.selection),
    theme?.name ?? "",
    palette.identity,
    paletteBgKey(palette),
    syntaxColors,
    convertedThemeIdentity(inputs.convertedThemes),
  ].join("\0");
}

/**
 * Memoized per collection: a session's conversions never change, and the session never mutates the
 * array.
 */
const convertedIdentities = new WeakMap<ReadonlyArray<ConvertedTheme>, string>();

/**
 * The collected conversions as an identity segment (name → source stem).
 *
 * @param converted - The session's collected conversions.
 * @returns A string unique to the collection.
 */
function convertedThemeIdentity(converted: ReadonlyArray<ConvertedTheme>): string {
  let identity = convertedIdentities.get(converted);
  if (identity === undefined) {
    identity = converted.map((entry) => `${entry.name}=${entry.stem}`).join("|");
    convertedIdentities.set(converted, identity);
  }
  return identity;
}

/**
 * The palette's four blend backgrounds as a cache key — the single source
 * both the active-theme memo and the enforced-variant cache key on.
 *
 * @param palette - The palette to serialize.
 * @returns The `bg|bg|bg|bg` key.
 */
function paletteBgKey(palette: DiffPalette): string {
  return `${palette.bgAdded}|${palette.bgRemoved}|${palette.bgAddedWord}|${palette.bgRemovedWord}`;
}

/**
 * The memoized resolution over EXPLICIT inputs — the session seam's entry
 * (session.ts owns the memo instance, so two sessions in one process
 * can never share or clobber each other's resolutions).
 *
 * @param memo - The session's memo instance.
 * @param inputs - The session's selection, conversions, and environment.
 * @param palette - The resolved palette the render uses.
 * @param theme - The pi theme behind it.
 * @returns The active theme, or null when unresolvable.
 */
export async function resolveActiveThemeMemoized(
  memo: ActiveThemeMemo,
  inputs: ThemeResolveInputs,
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
): Promise<ShikiThemeInput | null> {
  const identity = activeThemeIdentity(inputs, palette, theme);
  const memoized = memo.get(identity);
  if (memoized) return memoized;
  const resolving = resolveSelection(inputs, palette, theme);
  // Bounded (a session sees few identities; the bound only matters for
  // long test runs).
  memo.set(identity, resolving);
  return resolving;
}

/**
 * Resolve a selection against the render's palette polarity.
 *
 * @param inputs - The session's theme inputs.
 * @param palette - The resolved palette (polarity + enforcement backgrounds).
 * @param theme - The pi theme (the auto path's syntax color source).
 * @returns The theme input for codeToANSI, or null when unresolvable.
 */
async function resolveSelection(
  inputs: ThemeResolveInputs,
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
): Promise<ShikiThemeInput | null> {
  const target = inputs.selection;
  if (target.kind === "auto") return resolveAuto(inputs, palette, theme, {});
  if (target.kind === "file") {
    const variantType = target.file.theme.type;
    if (variantType === (palette.isLight ? "light" : "dark"))
      return enforceLoadedFile(target.file, palette);
    // Polarity-gated: fall through to auto (patches would continue via the
    // object wrapper; a bare file selection has none).
    return resolveAuto(inputs, palette, theme, {});
  }
  if (target.kind === "pair") {
    const half = palette.isLight ? target.light : target.dark;
    if (half && half.theme.type === (palette.isLight ? "light" : "dark"))
      return enforceLoadedFile(half, palette);
    // Missing half or mismatched type: fall through to auto.
    return resolveAuto(inputs, palette, theme, {});
  }

  // Object selection: resolve the base for the current polarity, then
  // overlay the patches (top-level colors, then the variant's colors).
  const variant = palette.isLight ? target.light : target.dark;
  const patches: SemanticColors = { ...target.colors, ...variant?.colors };
  // A variant's own base (a per-polarity theme file) wins over the
  // object's shared base — the pair form for user theme files.
  const base = variant?.base ?? target.base;

  if (!base || base.kind === "auto") {
    // Auto base (or no base): an inline variant with colors IS the theme —
    // merged with the top-level colors (the same key-merge the diff roots
    // use; the variant wins per key). Without a variant, the auto path
    // derives from the pi theme with the patches applied.
    if (variant?.colors && Object.keys(variant.colors).length > 0) {
      return buildSemanticTheme(
        { ...target.colors, ...variant.colors },
        palette.isLight ? "light" : "dark",
        "variant",
      );
    }
    return resolveAuto(inputs, palette, theme, patches);
  }
  // File/pair base: bundled names AA-enforce, user files render verbatim;
  // polarity-gated halves fall through to auto (patches continue on
  // whatever auto resolves to — possibly nothing).
  const half =
    base.kind === "file"
      ? base.file
      : base.kind === "pair"
        ? palette.isLight
          ? base.light
          : base.dark
        : undefined;
  if (!half || half.theme.type !== (palette.isLight ? "light" : "dark")) {
    return resolveAuto(inputs, palette, theme, patches);
  }
  if (!half.bundled) return applySemanticPatches(half.theme, patches, identityOf(target));
  const enforced = await enforceLoadedFile(half, palette);
  if (typeof enforced !== "string")
    return applySemanticPatches(enforced, patches, identityOf(target));
  if (!hasPatches(patches)) return enforced; // AA-clean id, nothing to overlay
  // AA-clean base (enforcement kept the id) with patches to apply: load
  // the object form so the overlay actually happens — returning the id
  // here would silently drop the user's colors. (The name is a valid
  // bundled id by construction — `bundled: true` is set only by the
  // direct-name intake.)
  const loaded = await loadBundledTheme(half.name as BundledTheme);
  return loaded ? applySemanticPatches(loaded, patches, identityOf(target)) : enforced;
}

/**
 * Resolve the auto theme: ours-detection first (the active pi theme IS one
 * of ours — the /theme selection maps back to its shiki source for the
 * full-precision pipeline), then the pi-derived nine-color fallback. The
 * bundled sources ride full tokenColors AA-enforced against the palette's
 * blend backgrounds; USER sources render VERBATIM (the enforcement
 * boundary — runtime AA is for our built-ins only, matching the
 * explicit-name path's user-file treatment). User patches apply verbatim
 * on the derived path, the rest AA-enforced. No substitute fallback —
 * when the pi theme's syntax colors do not resolve (non-truecolor
 * values), the honest behavior is unhighlighted code, matching the
 * large-diff fallback philosophy.
 *
 * @param inputs - The session's theme inputs (selection + conversions + env).
 * @param palette - The resolved palette (backgrounds drive enforcement).
 * @param theme - The pi theme (name drives ours-detection; syntax colors
 *   drive the derived fallback).
 * @param patches - Semantic color patches.
 * @returns The theme input, or null when derivation is impossible.
 */
async function resolveAuto(
  inputs: ThemeResolveInputs,
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
  patches: SemanticColors,
): Promise<ShikiThemeInput | null> {
  const ours = registeredSourceOf(theme?.name, inputs.convertedThemes);
  if (ours) {
    // Source dispatch lives HERE (the consumer): the collected conversions
    // are a pure name→source value; loading each source kind is the caller's
    // business.
    const loaded =
      ours.kind === "bundled"
        ? await loadBundledTheme(ours.themeName)
        : loadUserTheme(ours.fileName, inputs.themeEnv);
    if (loaded) {
      // The precise pipeline. BUNDLED sources ride full tokenColors,
      // AA-enforced against the palette's blend backgrounds (pi-pigment
      // supplies them — the runtime surface). USER sources render
      // VERBATIM: the author's colors are never enforced, the same
      // boundary the explicit-name path applies (AA is for our built-in
      // themes only).
      const tokenTheme =
        ours.kind === "bundled"
          ? enforceThemeColors(loaded, aaCheckBackgrounds(palette), !palette.isLight)
          : loaded;
      if (hasPatches(patches)) {
        return applySemanticPatches(tokenTheme, patches, `ours:${theme?.name ?? ""}`);
      }
      return tokenTheme;
    }
    // Load failure (a removed bundled module, a deleted user file): fall
    // through to the derived path — degraded, never broken.
  }
  const key = themeCacheKey(theme);
  return theme ? buildPiSyntaxTheme(theme, palette, key, patches) : null;
}

/**
 * A stable identity string for a selection (used in patch-name hashing).
 *
 * @param target - The object selection.
 * @returns The identity string.
 */
function identityOf(target: Extract<ThemeSelection, { kind: "object" }>): string {
  return JSON.stringify([target.colors, target.light ?? {}, target.dark ?? {}]);
}

/** Cache of enforced bundled names: name → (bgKey → theme). */
const enforcedCache = new Map<string, BoundedMap<string, ShikiThemeInput>>();

/**
 * Whether a patch map carries any overlay at all.
 *
 * @param patches - The semantic color patches.
 * @returns True when at least one patch key is set.
 */
export function hasPatches(patches: SemanticColors): boolean {
  return Object.keys(patches).length > 0;
}

/**
 * Route a loaded file through the AA boundary (ADR 0002): a
 * Shiki-bundled theme (any explicit selection by its bundled name — the
 * same source auto's precise pipeline maps pigment-* back to) is
 * enforced against the current effective backgrounds, so the same theme
 * renders identically under "auto" and an explicit name; a user file
 * renders verbatim (its author owns the tuning). Results are cached per
 * name + background identity.
 *
 * @param file - The loaded selection (single or pair half).
 * @param palette - The current palette (effective backgrounds).
 * @returns The enforced theme (object), the unchanged bundled id (already
 *   AA-clean — avoids materializing the object), or the user file verbatim.
 */
async function enforceLoadedFile(
  file: LoadedThemeFile,
  palette: DiffPalette,
): Promise<ShikiThemeInput> {
  if (!file.bundled) return file.theme; // user file: verbatim
  const variant = file.name as BundledTheme;
  const bgKey = paletteBgKey(palette);
  let perVariant = enforcedCache.get(variant);
  if (!perVariant) {
    // Bounded like its siblings (highlightCache 192, matcherMemo 64):
    // each bgKey entry holds a full theme object, and a session cycling
    // themes/roots would otherwise accumulate them indefinitely.
    perVariant = createBoundedMap<string, ShikiThemeInput>(16);
    enforcedCache.set(variant, perVariant);
  }
  const cached = perVariant.get(bgKey);
  if (cached) return cached;

  const theme = await loadBundledTheme(variant);
  if (!theme) return file.theme; // load failure: the virtual file's object
  const enforced = enforceThemeColors(theme, aaCheckBackgrounds(palette), !palette.isLight);
  const result = enforced === theme ? variant : enforced;
  perVariant.set(bgKey, result);
  return result;
}
