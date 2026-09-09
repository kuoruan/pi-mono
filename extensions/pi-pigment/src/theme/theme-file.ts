/**
 * The theme FILE channel (ADR 0006's user-theme path, the loading layer):
 * where theme files live (the config themes/ directories, project layer
 * first), how they parse (VS Code JSON and TextMate JSON, JSONC-tolerant,
 * plus .tmTheme XML plists via the tmtheme-plist intake),
 * and what they carry (the materialized theme plus their diff extension
 * key). Also the virtual file for direct bundled-theme names — the same
 * LoadedThemeFile shape, minus the filesystem. Selection STRATEGY (how a
 * config value resolves across this channel) lives in theme-resolver;
 * render-time interpretation in theme-selection.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { type ParseError, parse } from "jsonc-parser";

import { CONFIG_HOME } from "#src/config/config-schema.ts";
import { isLightRgb, isOpaqueHex6, parseRootColor } from "#src/core/color.ts";
import { fnv1a } from "#src/core/fingerprint.ts";

import { flattenTranslucentTokens, loadBundledTheme } from "./bundled-intake.ts";
import { DIFF_SIDES, isRootHex, type DiffRoots } from "./palette.ts";
import type { MaterializedTheme } from "./syntax-theme.ts";
import { parsePlistTheme } from "./tmtheme-plist.ts";

/** The environment theme resolution reads from. */
export interface ThemeEnv {
  /** Project working directory (the project themes/ root). */
  cwd: string;
  /** Explicit agent directory (test seam); defaults handled by the caller. */
  agentDir: string;
}

/** One resolution problem: reported to stderr at session_start, never fatal. */
export interface ThemeIssue {
  /** The human-readable problem. */
  message: string;
  /** The file it came from (when applicable). */
  sourcePath?: string;
}

/** A theme-file load: the parsed theme plus its diff extension key. */
export interface LoadedThemeFile {
  /** The theme's name (its file stem). */
  name: string;
  /**
   * The theme. User content renders verbatim (never enforced); a
   * Shiki-bundled theme (the virtual file of the direct-name channel) is
   * AA-enforced at render time — this flag routes that decision. The
   * materialized form: `loadThemeFile`/the direct-name intake validate
   * `type` and set `name` at the boundary.
   */
  theme: MaterializedTheme;
  /** True when this is a Shiki-bundled theme loaded by name (not a user file). */
  bundled?: boolean;
  /** The file's optional `diff` root overrides. */
  diffRoots?: DiffRoots;
}

/**
 * The themes/ directory under the PROJECT layer root (the cwd root needs
 * the `.pi` segment; the agent dir already sits under it — see
 * config-layer's globalConfigDir).
 *
 * @param cwd - The project working directory.
 * @returns The project themes directory path.
 */
function projectThemesDir(cwd: string): string {
  // CONFIG_DIR_NAME is the SDK's own (package-configurable) constant —
  // hardcoding ".pi" here would fork the roots if a package ever sets a
  // custom configDir.
  return join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_HOME, "themes");
}

/**
 * The themes/ directory under the GLOBAL layer root (the agent dir takes
 * no extra config-dir segment: `~/.pi/agent` already ends in it).
 *
 * @param agentDir - The resolved agent directory.
 * @returns The global themes directory path.
 */
function globalThemesDir(agentDir: string): string {
  return join(agentDir, "extensions", CONFIG_HOME, "themes");
}

/** Candidate theme-file extensions, in discovery order. */
export const THEME_FILE_EXTS = [".json", ".jsonc", ".tmTheme"] as const;

/**
 * The themes/ directories to search, project layer first (same-named
 * project files shadow global ones — mirroring the config layers'
 * precedence). The TUPLE return pins the order contract in the type —
 * layer annotations ([0] = project, [1] = global) derive from it.
 *
 * @param env - The environment.
 * @returns Project-then-global theme directory paths.
 */
export function themeDirs(env: ThemeEnv): readonly [string, string] {
  return [projectThemesDir(env.cwd), globalThemesDir(env.agentDir)];
}

/**
 * Locate a theme file by stem: project directory first, then global. The
 * stem must be a plain file name — anything carrying path separators or
 * parent references is rejected (the themes/ directories are the root).
 *
 * @param name - The theme file stem.
 * @param env - The environment.
 * @returns The file path, or undefined when absent everywhere.
 */
export function findThemeFile(name: string, env: ThemeEnv): string | undefined {
  if (!/^[\w.-]+$/.test(name)) return undefined;
  for (const dir of themeDirs(env)) {
    for (const ext of THEME_FILE_EXTS) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * A converted TextMate-JSON theme: the inferred polarity, pass-through rules, and the editor colors
 * from the global entry.
 */
interface ConvertedTextMateTheme {
  /** Inferred from the global background's luminance. */
  type: "light" | "dark";
  /** The scoped rules, passed through verbatim. */
  tokenColors: unknown[];
  /** `editor.background`/`editor.foreground` from the global entry. */
  colors: Record<string, string>;
}

/**
 * Convert a TextMate-JSON `settings` array (the tm-themes package shape)
 * to the internal theme fields.
 *
 * @param settings - The raw `settings` array.
 * @param name - The theme's name (for issue messages).
 * @param issues - The issue accumulator.
 * @param path - The source path (for issue messages).
 * @returns The converted fields (type/tokenColors/colors), or undefined when the theme is unusable.
 */
function convertTextMateSettings(
  settings: unknown[],
  name: string,
  issues: ThemeIssue[],
  path: string,
): ConvertedTextMateTheme | undefined {
  let global: Record<string, unknown> | undefined;
  const rules: Array<Record<string, unknown>> = [];
  for (const entry of settings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.scope === undefined) {
      // The FIRST scope-less entry is the global one (TextMate convention).
      global ??= (record.settings as Record<string, unknown>) ?? {};
      continue;
    }
    const ruleSettings = record.settings;
    if (typeof ruleSettings === "object" && ruleSettings !== null) {
      rules.push({ scope: record.scope, settings: ruleSettings });
    }
  }
  // The global entry's background IS the theme's editor.background (the
  // tm-themes convention) — the canvas, not a diff root.
  const editorBackground = global?.background;
  if (typeof editorBackground !== "string" || !isOpaqueHex6(editorBackground)) {
    // Opaque 6-digit only: an 8-digit canvas would skip translucency
    // flattening downstream (it matches only 6-digit) and fall to the
    // gray fallback — fail loudly here instead.
    issues.push({
      message: `The TextMate theme "${name}" needs an opaque #rrggbb global background (to infer polarity and flatten translucent tokens); it was skipped.`,
      sourcePath: path,
    });
    return undefined;
  }
  const root = parseRootColor(editorBackground);
  if (!root) return undefined; // unreachable (checked above); narrows the type
  const type = isLightRgb(root.rgb) ? "light" : "dark";
  // The global entry becomes the editor colors downstream code reads
  // (default token fg, translucency flattening canvas). The selection/
  // find-highlight keys pass through as the VS Code color keys the
  // converter reads (the same passthrough shape as the diffEditor keys).
  const colors: Record<string, string> = {
    "editor.background": editorBackground,
  };

  if (typeof global?.foreground === "string") {
    colors["editor.foreground"] = global.foreground;
  }
  if (typeof global?.selection === "string") {
    colors["editor.selectionBackground"] = global.selection;
  }
  if (typeof global?.findHighlight === "string") {
    colors["editor.findMatchBackground"] = global.findHighlight;
  }
  if (typeof global?.findHighlightForeground === "string") {
    colors["editor.findMatchForeground"] = global.findHighlightForeground;
  }
  return { type, tokenColors: rules, colors };
}

/**
 * The sanitized stem (the registered output's naming).
 *
 * @param stem - The source stem.
 * @returns The sanitized stem.
 */
export function sanitizedStemOf(stem: string): string {
  return stem.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * The TextMate-JSON shape test (a `settings` array, no `type`): a type
 * guard (not a plain boolean) so the settings array arrives narrowed to
 * unknown[] without a cast at the read.
 *
 * @param r - The parsed theme record.
 * @returns True when the record is the tm-themes redistribution shape.
 */
function isTextMateShape(
  r: Record<string, unknown>,
): r is Record<string, unknown> & { settings: unknown[] } {
  return r.type === undefined && !Array.isArray(r.tokenColors) && Array.isArray(r.settings);
}

/**
 * Parse and validate a theme file. Three forms accepted, chosen by
 * EXTENSION (no content sniffing — a .tmTheme renamed to .json fails as
 * JSON and is reported for what it is): VS Code JSON (`type` +
 * `tokenColors` required; `type` gates polarity), TextMate JSON (a
 * `settings` array; polarity inferred from the global background), and
 * the original .tmTheme XML plist (parsed by the tmtheme-plist intake
 * into the same TextMate shape). JSON is JSONC-tolerant; the optional
 * `diff` extension key extracted. Exported for the user-theme conversion
 * channel (the same loader, the same rules).
 *
 * @param path - The file path.
 * @param issues - The issue accumulator.
 * @returns The loaded theme file, or undefined when unusable.
 */
export function loadThemeFile(path: string, issues: ThemeIssue[]): LoadedThemeFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ message: `Failed to read the theme file: ${message}`, sourcePath: path });
    return undefined;
  }

  let parsed: unknown;
  if (path.endsWith(".tmTheme")) {
    try {
      parsed = parsePlistTheme(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({
        message: `The .tmTheme theme file is not a valid plist (${message}); it was skipped.`,
        sourcePath: path,
      });
      return undefined;
    }
  } else {
    const errors: ParseError[] = [];
    parsed = parse(text, errors, { allowTrailingComma: true });
    if (
      errors.length > 0 ||
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      issues.push({
        message: `The theme file is not valid JSONC; it was skipped.`,
        sourcePath: path,
      });
      return undefined;
    }
  }

  const record = parsed as Record<string, unknown>;
  const stem = path.split("/").pop() ?? "theme";
  const name = stem.replace(/\.(json|jsonc|tmTheme)$/, "");
  // The content fingerprint rides the theme: the highlight cache keys
  // file-channel themes by name, and a bare stem would serve stale colors
  // after the file is edited and a session resumed (module state survives;
  // session_start re-reads the file but the cache hit precedes it).
  const fingerprint = fnv1a(text);
  // Two accepted shapes plus the .tmTheme plist form (parsed into the
  // TextMate shape): VS Code JSON (`type` + `tokenColors`) and TextMate
  // JSON (a `settings` array, no `type` — the tm-themes package
  // redistribution shape). The tm shape converts: rules become tokenColors
  // verbatim (vscode-textmate splits comma scopes itself), the global
  // entry becomes `colors["editor.background"|"foreground"]`, and
  // polarity is INFERRED from the global background's luminance.

  let type: unknown;
  let tokenColors: unknown;
  let colors: unknown;
  if (isTextMateShape(record)) {
    const converted = convertTextMateSettings(record.settings, name, issues, path);
    if (!converted) return undefined;
    ({ type, tokenColors, colors } = converted);
  } else {
    type = record.type;
    tokenColors = record.tokenColors;
    colors = record.colors;
    if (type !== "light" && type !== "dark") {
      issues.push({
        message: `The theme file needs "type": "light" or "dark" (polarity gating) — or, for a TextMate theme, a "settings" array with a global background to infer it; it was skipped.`,
        sourcePath: path,
      });
      return undefined;
    }
    if (!Array.isArray(tokenColors)) {
      issues.push({
        message: `The theme file needs a "tokenColors" array; it was skipped.`,
        sourcePath: path,
      });
      return undefined;
    }
  }

  const { diff, colors: _c, settings: _s, ...themeRest } = record;
  const diffRoots = extractDiffRoots(diff, colors, name, issues);
  // The same materialization the bundled-theme intake applies: 8-digit
  // token colors composite onto the theme's own canvas (a VS Code-copied
  // file with translucent punctuation must not fall to gray).
  const theme = flattenTranslucentTokens({
    ...(themeRest as object),
    colors,
    name,
    type,
    tokenColors,
    contentFingerprint: fingerprint,
  } as MaterializedTheme);
  return { name, theme, diffRoots };
}

/**
 * Extract the diff roots from a theme file: the explicit `diff` key wins
 * per-slot over the VS Code passthrough (the `colors` dict's
 * `diffEditor.insertedTextBackground`/`removedTextBackground`, ADR 0003).
 * Unknown `diff` keys produce an issue.
 *
 * @param diff - The file's `diff` value (unknown).
 * @param colors - The file's `colors` value (unknown).
 * @param name - The theme's name (for issue messages).
 * @param issues - The issue accumulator.
 * @returns The merged roots, or undefined when none.
 */
function extractDiffRoots(
  diff: unknown,
  colors: unknown,
  name: string,
  issues: ThemeIssue[],
): DiffRoots | undefined {
  let roots: DiffRoots | undefined;
  if (typeof diff === "object" && diff !== null && !Array.isArray(diff)) {
    const record = diff as Record<string, unknown>;
    const validKeys = [...DIFF_SIDES] as const;
    for (const key of Object.keys(record)) {
      if (!(validKeys as readonly string[]).includes(key)) {
        issues.push({
          message: `Unknown diff key "${key}" in theme "${name}" — valid keys: ${validKeys.join(", ")}.`,
        });
        continue;
      }
      const value = record[key];
      // The canvas is not a root (ADR 0006): sides only.
      const side = key as Exclude<keyof DiffRoots, never>;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({
          message: `Diff side "${key}" in theme "${name}" must be an object with "text"/"tint" — it was ignored.`,
        });
        continue;
      }
      const sideRecord = value as Record<string, unknown>;
      for (const slot of Object.keys(sideRecord)) {
        if (slot !== "text" && slot !== "tint") {
          issues.push({
            message: `Unknown diff slot "${slot}" in theme "${name}" side "${key}" — valid slots: text, tint.`,
          });
          continue;
        }
        if (typeof sideRecord[slot] !== "string" || !isRootHex(slot, sideRecord[slot])) {
          // ADR 0003: the key IS the semantics — text takes opaque
          // #rrggbb, tint takes #rrggbbaa; CSS shorthands (#rgb / #rgba)
          // expand; anything else is reported and dropped, not silently
          // ignored.
          issues.push({
            message: `Diff slot "${key}.${slot}" in theme "${name}" must be ${
              slot === "tint" ? "a #rrggbbaa (or #rgba) tint" : "opaque #rrggbb (or #rgb)"
            }: ${JSON.stringify(sideRecord[slot])} — it was ignored.`,
          });
          continue;
        }
        roots ??= {};
        roots[side] ??= {};
        (roots[side] as Record<string, string>)[slot] = sideRecord[slot] as string;
      }
    }
  } else if (diff !== undefined) {
    issues.push({
      message: `The "diff" key in theme "${name}" must be an object; it was ignored.`,
    });
  }
  // VS Code passthrough: the colors dict's diffEditor tint keys become
  // the sides' tint roots zero-config (tint semantics — the source keys
  // are VS Code tints). Only tints translate (8-digit or #rgba); an
  // opaque value violates VS Code's own "must not be opaque" contract
  // and is dropped with an issue. The explicit `diff` key wins per slot.
  if (typeof colors === "object" && colors !== null && !Array.isArray(colors)) {
    const colorDict = colors as Record<string, unknown>;
    const inserted = colorDict["diffEditor.insertedTextBackground"];
    const removed = colorDict["diffEditor.removedTextBackground"];
    if (typeof inserted === "string" || typeof removed === "string") {
      roots = { ...roots };
      if (typeof inserted === "string" && !roots.added?.tint) {
        if (!isRootHex("tint", inserted)) {
          issues.push({
            message: `Passthrough "diffEditor.insertedTextBackground" in theme "${name}" must be a #rrggbbaa (or #rgba) tint (VS Code documents it as non-opaque): ${JSON.stringify(inserted)} — it was ignored.`,
          });
        } else {
          roots.added = { ...roots.added, tint: inserted };
        }
      }
      if (typeof removed === "string" && !roots.removed?.tint) {
        if (!isRootHex("tint", removed)) {
          issues.push({
            message: `Passthrough "diffEditor.removedTextBackground" in theme "${name}" must be a #rrggbbaa (or #rgba) tint (VS Code documents it as non-opaque): ${JSON.stringify(removed)} — it was ignored.`,
          });
        } else {
          roots.removed = { ...roots.removed, tint: removed };
        }
      }
    }
  }
  return roots;
}

/**
 * Assemble the virtual theme file for a direct bundled-theme name: the
 * intake's materialized theme (verbatim, translucent-flattened) plus the
 * passthrough roots from its `colors` dict — the same LoadedThemeFile the
 * filesystem channel produces, minus the filesystem.
 *
 * @param name - The bundled theme name (already validated).
 * @returns The virtual loaded file, or undefined when the load fails.
 */
export async function loadBundledThemeByName(name: string): Promise<LoadedThemeFile | undefined> {
  const theme = await loadBundledTheme(name);
  if (!theme) return undefined;
  // The passthrough's validation issues are dropped: the input
  // is a FIXED bundled theme (not user content), and a validation failure
  // here would mean a shiki-release change — the conversion channel's
  // issues surface it where it matters.
  const diffRoots = extractDiffRoots(undefined, theme.colors, name, []);
  return { name, theme, bundled: true, diffRoots };
}
