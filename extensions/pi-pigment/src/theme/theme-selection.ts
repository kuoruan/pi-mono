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
import { registeredSourceOf } from "./theme-registry.ts";
import type { ThemeSelection } from "./theme-resolver.ts";
import { loadUserTheme } from "./user-themes.ts";

/** The session's resolved theme selection (set at session_start). */
let selection: ThemeSelection = { kind: "auto" };
/**
 * The selection's serialized form — computed once per selection (file/object
 * selections embed whole theme objects, and the identity runs per block).
 */
let selectionFingerprint = JSON.stringify(selection);

/**
 * The memo for the active theme: identity key → resolved theme promise.
 * Keyed by identity (a small map, not a single slot): interleaved callers
 * with different identities each hit their own entry — a single-slot memo
 * thrashes under parallel test workers sharing this module, and a thrashed
 * resolve handed the wrong theme's colors to the wrong renderer.
 */
const activeThemeMemo = createBoundedMap<string, Promise<ShikiThemeInput | null>>(8);

/**
 * Select the syntax theme (the theme-resolver's session-time product) and
 * reset the render-time memo. No prewarming (measured: the
 * engine import is paid at load time, the first tokenize's regex compile
 * is inherently first-use — see highlight.ts's note).
 *
 * @param next - The resolved selection.
 */
export function setSyntaxThemeSelection(next: ThemeSelection): void {
  selection = next;
  selectionFingerprint = JSON.stringify(next);
  activeThemeMemo.clear();
}

/**
 * Reset the selection to auto and drop the memos (test seam). The enforced
 * variant cache is keyed by background, not by theme — without clearing it,
 * a parallel test's theme locks the auto-derived variant under a shared
 * background key and later tests render with the wrong polarity's syntax
 * colors.
 */
export function resetSyntaxThemeForTest(): void {
  selection = { kind: "auto" };
  selectionFingerprint = JSON.stringify(selection);
  activeThemeMemo.clear();
  enforcedCache.clear();
}

/**
 * The identity the active-theme memo keys on: the selection, the pi theme
 * (name included — the ours-detection input), and the palette roots
 * (backgrounds) — every input that changes the output.
 *
 * @param palette - The resolved palette (backgrounds drive enforcement).
 * @param theme - The pi theme (its name drives ours-detection).
 * @returns A string unique to the resolution inputs.
 */
function activeThemeIdentity(palette: DiffPalette, theme: PaletteTheme | undefined): string {
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
    selectionFingerprint,
    theme?.name ?? "",
    palette.identity,
    paletteBgKey(palette),
    syntaxColors,
  ].join("\0");
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
 * Resolve the active Shiki theme for the current render (async: name
 * enforcement loads bundled theme objects). Memoized on the full identity —
 * theme switches, root overrides, and config reloads all produce a fresh
 * resolution and a fresh highlight-cache key.
 *
 * @param palette - The resolved palette the render uses.
 * @param theme - The pi theme behind it.
 * @returns The active theme — a bundled id or a theme object — or null when
 *   the selection resolves to no theme (auto derivation impossible).
 */
export async function resolveActiveTheme(
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
): Promise<ShikiThemeInput | null> {
  const identity = activeThemeIdentity(palette, theme);
  const memoized = activeThemeMemo.get(identity);
  if (memoized) return memoized;
  const resolving = resolveSelection(selection, palette, theme);
  // Bounded (a session sees few identities; the bound only matters for
  // long test runs).
  activeThemeMemo.set(identity, resolving);
  return resolving;
}

/**
 * Resolve a selection against the render's palette polarity.
 *
 * @param target - The selection to resolve.
 * @param palette - The resolved palette (polarity + enforcement backgrounds).
 * @param theme - The pi theme (the auto path's syntax color source).
 * @returns The theme input for codeToANSI, or null when unresolvable.
 */
async function resolveSelection(
  target: ThemeSelection,
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
): Promise<ShikiThemeInput | null> {
  if (target.kind === "auto") return resolveAuto(palette, theme, {});
  if (target.kind === "file") {
    const variantType = target.file.theme.type;
    if (variantType === (palette.isLight ? "light" : "dark"))
      return enforceLoadedFile(target.file, palette);
    // Polarity-gated: fall through to auto (patches would continue via the
    // object wrapper; a bare file selection has none).
    return resolveAuto(palette, theme, {});
  }
  if (target.kind === "pair") {
    const half = palette.isLight ? target.light : target.dark;
    if (half && half.theme.type === (palette.isLight ? "light" : "dark"))
      return enforceLoadedFile(half, palette);
    // Missing half or mismatched type: fall through to auto.
    return resolveAuto(palette, theme, {});
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
    return resolveAuto(palette, theme, patches);
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
    return resolveAuto(palette, theme, patches);
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
 * @param palette - The resolved palette (backgrounds drive enforcement).
 * @param theme - The pi theme (name drives ours-detection; syntax colors
 *   drive the derived fallback).
 * @param patches - Semantic color patches.
 * @returns The theme input, or null when derivation is impossible.
 */
async function resolveAuto(
  palette: DiffPalette,
  theme: PaletteTheme | undefined,
  patches: SemanticColors,
): Promise<ShikiThemeInput | null> {
  const ours = registeredSourceOf(theme?.name);
  if (ours) {
    // Source dispatch lives HERE (the consumer): the registry is a pure
    // name→source table; loading each source kind is the caller's business
    // (one-directional imports — no registry⇄user-themes cycle).
    const loaded =
      ours.kind === "bundled"
        ? await loadBundledTheme(ours.themeName)
        : loadUserTheme(ours.fileName);
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
