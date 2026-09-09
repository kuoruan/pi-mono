/**
 * Session-time resolution STRATEGY of the `syntaxTheme` config value
 * (ADR 0002/0006): string values follow pi's theme-setting grammar — a
 * single theme name or an explicit "light-half/dark-half" slash pair
 * (first half renders on light pi themes, second on dark) — where every
 * name is either a Shiki-bundled theme ("vitesse-dark") or a themes/
 * file stem ("mytheme"); objects resolve their base recursively and
 * split into a theme selection plus a diff-roots spec. The file channel
 * (discovery, parsing, the virtual bundled file) lives in theme-file;
 * this module decides between its products. Render-time interpretation
 * lives in theme-selection.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type ThemeObject, type ThemeVariant } from "#src/config/config-schema.ts";

import { isBundledThemeName } from "./bundled-intake.ts";
import { type DiffRoots, type DiffRootsSpec } from "./palette.ts";
import type { SemanticColors } from "./syntax-theme.ts";
import {
  type LoadedThemeFile,
  type ThemeEnv,
  type ThemeIssue,
  findThemeFile,
  loadBundledThemeByName,
  loadThemeFile,
  themeDirs,
  THEME_FILE_EXTS,
} from "./theme-file.ts";
import { PIGMENT_PREFIX } from "./theme-registry.ts";

/**
 * A polarity variant on the selection: the config patches plus the
 * RESOLVED base for that polarity (a theme name, a slash pair, or auto)
 * — resolution happens at session_start so render time needs no env.
 */
export interface SelectedVariant {
  /** The resolved per-polarity base (undefined inherits the object's base). */
  base?: ThemeSelection;
  /** Semantic color patches for this polarity. */
  colors?: SemanticColors;
}

/** The resolved theme selection (consumed by highlight's render-time resolution). */
export type ThemeSelection =
  | { kind: "auto" }
  | { kind: "file"; file: LoadedThemeFile }
  | {
      /** An explicit light/dark pair (pi's "a/b" theme-setting grammar). */
      kind: "pair";
      /** The light-position half (absent = that polarity falls back to auto). */
      light?: LoadedThemeFile;
      /** The dark-position half (absent = that polarity falls back to auto). */
      dark?: LoadedThemeFile;
    }
  | {
      kind: "object";
      base: ThemeSelection;
      /** Colors patching both polarities. */
      colors: SemanticColors;
      /** Per-polarity variants (bases resolved, patches carried). */
      light?: SelectedVariant;
      dark?: SelectedVariant;
    };

/** Result of resolving the syntaxTheme config value. */
export interface ThemeResolution {
  /** The selection for highlight's render-time resolution. */
  selection: ThemeSelection;
  /** The diff-roots spec for the palette. */
  rootsSpec: DiffRootsSpec | undefined;
  /** Issues to stderr at session_start. */
  issues: ThemeIssue[];
}

/**
 * Resolve one name of a pair (or a single name): a Shiki-bundled theme
 * name or a themes/ file stem, loaded through the shared file channel.
 *
 * @param name - The name as written (a slash-free half or a single value).
 * @param env - The environment.
 * @param issues - The issue accumulator.
 * @param position - The half's position (for issue wording).
 * @returns The loaded file, or undefined (issue recorded) when unresolvable.
 */
async function resolveName(
  name: string,
  env: ThemeEnv,
  issues: ThemeIssue[],
  position: string,
): Promise<LoadedThemeFile | undefined> {
  if (name === "auto") {
    issues.push({
      message: `"auto" is not valid as a pair half (${position}) — halves name themes; the missing-polarity fallback to auto is implicit.`,
    });
    return undefined;
  }
  if (isBundledThemeName(name)) {
    warnIfShadowed(name, env, issues);
    const file = await loadBundledThemeByName(name);
    if (file) return file;
    issues.push({
      message: `The bundled theme "${name}" failed to load — its pair position (${position}) falls back to "auto".`,
    });
    return undefined;
  }
  const filePath = findThemeFile(name, env);
  if (filePath) {
    // A converted product referenced by name: it is a pi-theme JSON (the
    // /theme payload), not a Shiki theme. The source stem keeps
    // working; conversion never retires it.
    if (name.startsWith(PIGMENT_PREFIX)) {
      issues.push({
        message: `"${name}" is a converted pi theme (the /theme payload, not a Shiki theme) — pick it in /settings → Theme, or reference its source stem "${name.slice(PIGMENT_PREFIX.length)}" for the token override. Falling back to "auto".`,
        sourcePath: filePath,
      });
      return undefined;
    }
    // Found but failed to parse: loadThemeFile already recorded its own
    // issue — a "matches no file" follow-up would point the user at
    // renaming when the fix is the file's content.
    return loadThemeFile(filePath, issues);
  }
  issues.push({
    message: `The theme name "${name}" (${position}) matches no Shiki-bundled theme and no themes/ file — falling back to "auto".`,
  });
  return undefined;
}

/**
 * Resolve a base reference (a string) to a selection, one chain used at
 * every base site. The grammar mirrors pi's theme setting: a single name
 * (Shiki-bundled or a themes/ stem, polarity-gated) or one explicit
 * slash pair "light/dark"; "auto" and unknown names fall back with an
 * issue.
 *
 * @param value - The base string.
 * @param env - The environment.
 * @param issues - The issue accumulator.
 * @returns The resolved selection.
 */
async function resolveBase(
  value: string,
  env: ThemeEnv,
  issues: ThemeIssue[],
): Promise<ThemeSelection> {
  if (value === "auto") {
    warnIfShadowed("auto", env, issues);
    return { kind: "auto" };
  }
  // The slash pair (pi's grammar): exactly one "/", both halves non-empty.
  // Position is the polarity — the first half renders on light pi themes,
  // the second on dark — and each half is a theme name (never "auto",
  // never a nested pair).
  const slash = value.indexOf("/");
  if (slash !== -1) {
    if (value.indexOf("/", slash + 1) !== -1) {
      issues.push({
        message: `syntaxTheme "${value}" carries more than one "/" — the pair grammar is "light-theme/dark-theme". Falling back to "auto".`,
      });
      return { kind: "auto" };
    }
    const lightName = value.slice(0, slash).trim();
    const darkName = value.slice(slash + 1).trim();
    if (!lightName || !darkName) {
      issues.push({
        message: `syntaxTheme "${value}" has an empty pair half — the pair grammar is "light-theme/dark-theme". Falling back to "auto".`,
      });
      return { kind: "auto" };
    }
    const light = await resolveName(lightName, env, issues, "light half");
    const dark = await resolveName(darkName, env, issues, "dark half");
    if (!light && !dark) return { kind: "auto" };
    // A half whose INTERNAL type contradicts its position can never
    // render (both gates fail) — say so instead of a silent dead half
    // (the classic copy-a-dark-theme-forget-to-flip case).
    if (light && light.theme.type !== "light") {
      issues.push({
        message: `The light half "${lightName}" carries "type": "${light.theme.type}" — it can never render from the light position. Fix the theme or swap the halves.`,
      });
    }
    if (dark && dark.theme.type !== "dark") {
      issues.push({
        message: `The dark half "${darkName}" carries "type": "${dark.theme.type}" — it can never render from the dark position. Fix the theme or swap the halves.`,
      });
    }
    return { kind: "pair", light, dark };
  }
  // Single name: a Shiki-bundled theme (AA-enforced at render time) or a
  // themes/ file (verbatim). A converted source keeps working — the
  // conversion registers a pi theme for /theme; it does not retire the
  // file from the token channel.
  const file = await resolveName(value, env, issues, "single name");
  return file ? { kind: "file", file } : { kind: "auto" };
}

/**
 * Emit an informational issue when a themes/ file is shadowed by a
 * built-in name ("auto" or a Shiki-bundled theme): the file can never be
 * selected by that name.
 *
 * @param name - The shadowing built-in name.
 * @param env - The environment.
 * @param issues - The issue accumulator.
 */
function warnIfShadowed(name: string, env: ThemeEnv, issues: ThemeIssue[]): void {
  for (const dir of themeDirs(env)) {
    for (const ext of THEME_FILE_EXTS) {
      // Exact files AND pair halves (name-light/name-dark) are both
      // unreachable when a built-in owns the name.
      for (const suffix of ["", "-light", "-dark"]) {
        if (existsSync(join(dir, `${name}${suffix}${ext}`))) {
          issues.push({
            message: `A theme file named "${name}${suffix}" is shadowed by the built-in "${name}" — the built-in is used. Rename the file to select it.`,
            sourcePath: join(dir, `${name}${suffix}${ext}`),
          });
          return;
        }
      }
    }
  }
}

/**
 * Resolve the `syntaxTheme` config value (the OVERRIDE layer, ADR 0006):
 * an explicit selection (a bundled name, a themes/ file, a slash pair,
 * an object) that renders its token colors over the pi theme's chrome.
 * The roots spec carries ONLY the user's own diff keys (object form) —
 * channel roots moved to the converter at generation time.
 *
 * @param value - The validated config value (string or theme object).
 * @param env - The environment.
 * @returns The resolution (selection, roots spec, issues).
 */
export async function resolveSyntaxThemeSelection(
  value: string | ThemeObject,
  env: ThemeEnv,
): Promise<ThemeResolution> {
  const issues: ThemeIssue[] = [];

  if (typeof value === "string") {
    const selection = await resolveBase(value, env, issues);
    return { selection, rootsSpec: undefined, issues };
  }

  // Object form: resolve the base (default auto); the user's diff keys
  // are the only roots.
  const base = value.base !== undefined ? await resolveBase(value.base, env, issues) : undefined;

  const selection: ThemeSelection = {
    kind: "object",
    base: base ?? { kind: "auto" },
    colors: value.colors ?? {},
    light: await resolveVariant(value.light, env, issues),
    dark: await resolveVariant(value.dark, env, issues),
  };
  return { selection, rootsSpec: userRootsSpecOf(value), issues };
}

/**
 * Resolve a config variant for the selection: its `base` string (when set)
 * resolves to a selection NOW (session time — file loads need the env);
 * the patches pass through for render time.
 *
 * @param variant - The config variant (may be undefined).
 * @param env - The environment (theme-file loads).
 * @param issues - The issue accumulator.
 * @returns The selected variant, or undefined when the config variant is absent.
 */
async function resolveVariant(
  variant: ThemeVariant | undefined,
  env: ThemeEnv,
  issues: ThemeIssue[],
): Promise<SelectedVariant | undefined> {
  if (!variant) return undefined;
  const resolved: SelectedVariant = { colors: variant.colors };
  if (variant.base !== undefined) {
    resolved.base = await resolveBase(variant.base, env, issues);
  }
  return resolved;
}

/**
 * The user-config roots spec (ADR 0006): ONLY the object form's explicit
 * diff keys — top-level shared, per-variant per-polarity. Everything a
 * theme would have contributed moved to the converter at generation time
 * (the registered pi theme's slots); the palette reads those slots.
 *
 * @param value - The validated theme object.
 * @returns The roots spec, or undefined when no diff keys are set.
 */
function userRootsSpecOf(value: ThemeObject): DiffRootsSpec | undefined {
  const topLevel = value.diff !== undefined && hasRootContent(value.diff) ? value.diff : undefined;
  const variantRoots = (variant: ThemeVariant | undefined): DiffRoots | undefined =>
    variant?.diff !== undefined && hasRootContent(variant.diff) ? variant.diff : undefined;
  const light = variantRoots(value.light);
  const dark = variantRoots(value.dark);
  if (topLevel === undefined && light === undefined && dark === undefined) return undefined;
  return { topLevel, light, dark };
}

/**
 * Whether a roots object carries any content (any slot set).
 *
 * @param roots - The roots object.
 * @returns True when any slot is set.
 */
function hasRootContent(roots: DiffRoots): boolean {
  return (
    roots.added?.text !== undefined ||
    roots.added?.tint !== undefined ||
    roots.removed?.text !== undefined ||
    roots.removed?.tint !== undefined
  );
}
