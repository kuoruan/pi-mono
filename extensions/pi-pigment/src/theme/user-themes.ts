/**
 * The custom-theme channel (ADR 0006): user theme files in the config
 * `themes/` directories. Conversion is MANUAL (`/pigment convert` — the
 * command module drives it); outputs land NEXT TO their sources
 * (`pigment-<stem>.json`) and are registered with pi at resources_discover
 * time by listing them (individual files, not the directory — the
 * directory also holds TextMate theme sources pi must not try to load).
 *
 * Candidate rule: when `pigment-<stem>.json` exists, the source
 * `<stem>.<ext>` drops out of the CONVERT CANDIDATES only (the output is
 * its registered identity — no duplicate entries). It keeps resolving as
 * a `syntaxTheme` token override (conversion never retires the source —
 * see theme-resolver), still serves the precise pipeline (ours-detection
 * loads it for full tokenColors) and re-conversion (delete the output to
 * re-list it). Delete the source and the output stands alone (external
 * theme path — its nine colors still derive well).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ConfigLayer } from "#src/config/config-layer.ts";

import { isBundledThemeName } from "./bundled-intake.ts";
import { convertToPiTheme } from "./pi-theme-converter.ts";
import type { MaterializedTheme } from "./syntax-theme.ts";
import {
  type LoadedThemeFile,
  type ThemeEnv,
  type ThemeIssue,
  loadThemeFile,
  sanitizedStemOf,
  THEME_FILE_EXTS,
  themeDirs,
} from "./theme-file.ts";
import { PIGMENT_PREFIX, registerUserTheme } from "./theme-registry.ts";

/**
 * The output file name for a source stem.
 *
 * @param stem - The source stem.
 * @returns The output file name.
 */
export function outputFileName(stem: string): string {
  return `${PIGMENT_PREFIX}${sanitizedStemOf(stem)}.json`;
}

/**
 * The registered pi theme name for a user theme file stem.
 *
 * @param stem - The source stem.
 * @returns The prefixed, sanitized pi theme name.
 */
export function piNameForUserStem(stem: string): string {
  return `${PIGMENT_PREFIX}${sanitizedStemOf(stem)}`;
}

/**
 * Whether a directory entry name is a conversion OUTPUT (pigment-*.json —
 * never a convert candidate, never a syntaxTheme source).
 *
 * @param name - The directory entry name.
 * @returns True when the name is an output file.
 */
function isOutputFile(name: string): boolean {
  return name.startsWith(PIGMENT_PREFIX) && name.endsWith(".json");
}

/**
 * One themes/ directory scan — sources AND conversion outputs in a single
 * readdir (the retirement test and the source listing share the pass).
 */
interface DirScan {
  /** Source stems → paths (outputs excluded — they are pi themes). */
  readonly sources: Map<string, string>;
  /** The stems with a conversion OUTPUT (pigment-<stem>.json). */
  readonly outputs: string[];
}

/**
 * Scan a themes/ directory once.
 *
 * @param dir - The directory to scan.
 * @returns The scan, or undefined for absent/unreadable dirs (cosmetic
 *   fails safe — the theme channel skips them like missing ones).
 */
function scanThemesDir(dir: string): DirScan | undefined {
  if (!existsSync(dir)) return undefined;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const sources = new Map<string, string>();
  const outputs: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (isOutputFile(entry.name)) {
      outputs.push(entry.name.slice(PIGMENT_PREFIX.length, -".json".length));
      continue;
    }
    if (THEME_FILE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      sources.set(entry.name.replace(/\.(json|jsonc|tmTheme)$/, ""), join(dir, entry.name));
    }
  }
  return { sources, outputs };
}

/**
 * Load one layer's unretired sources (the scan is already in hand —
 * the two-pass scan's per-layer step). Load failures ride the issues
 * channel; a failed file just never enters the list.
 *
 * @param scan - The layer's directory scan.
 * @param layer - The layer's identity.
 * @param retired - The cross-layer retirement set (outputs anywhere).
 * @param issues - The issue accumulator.
 * @returns The layer's loaded sources.
 */
function loadLayerSources(
  scan: DirScan | undefined,
  layer: ConfigLayer,
  retired: ReadonlySet<string>,
  issues: ThemeIssue[],
): ScannedFile[] {
  if (scan === undefined) return [];
  const files: ScannedFile[] = [];
  for (const [stem, path] of scan.sources) {
    if (retired.has(stem)) continue;
    const loaded = loadThemeFile(path, issues);
    if (loaded) files.push({ file: loaded, layer, fileName: basename(path) });
  }
  return files;
}

/** A scanned source with its config layer (project shadows global). */
interface ScannedFile {
  /** The loaded theme file. */
  file: LoadedThemeFile;
  /** The layer the file came from. */
  layer: ConfigLayer;
  /** The source FILE name as scanned (issue wording — not the stem). */
  fileName: string;
}

/**
 * Scan the theme sources across BOTH config layers: global first, then
 * project, merged with the PROJECT entry overwriting its global twin
 * (the shadowing contract). The two directory scans happen FIRST so the
 * retirement evidence from both layers retires a stem everywhere — an
 * output `pigment-<stem>.json` anywhere drops the source from the
 * candidates (the documented per-stem rule, not per-layer).
 *
 * @param env - The environment.
 * @param issues - The issue accumulator (load failures).
 * @returns The loaded, unretired sources with their layers.
 */
function scanUserThemeFiles(env: ThemeEnv, issues: ThemeIssue[]): ScannedFile[] {
  const [projectDir, globalDir] = themeDirs(env);
  const projectScan = scanThemesDir(projectDir);
  const globalScan = scanThemesDir(globalDir);
  const retired = new Set([...(projectScan?.outputs ?? []), ...(globalScan?.outputs ?? [])]);
  const byStem = new Map<string, ScannedFile>();
  for (const file of loadLayerSources(globalScan, "global", retired, issues)) {
    byStem.set(file.file.name, file);
  }
  for (const file of loadLayerSources(projectScan, "project", retired, issues)) {
    byStem.set(file.file.name, file); // the project twin overwrites
  }
  return [...byStem.values()];
}

/**
 * One convertible source: the picker-facing identity (stem + layer).
 * The command resolves the picker by index over these — the pretty
 * `stem (layer)` labels are never parsed back.
 */
export interface ConvertCandidate {
  /** The source stem (the typed name / picker identity). */
  readonly stem: string;
  /** The layer the source lives in (project shadows global). */
  readonly layer: ConfigLayer;
}

/**
 * The convertible sources WITH their layers (the picker's annotated
 * list — load failures ride the issues channel). Retired sources and
 * outputs are absent.
 *
 * @param env - The environment.
 * @returns The candidates and any load issues.
 */
export function listConvertCandidateEntries(env: ThemeEnv): {
  entries: ConvertCandidate[];
  issues: ThemeIssue[];
} {
  const issues: ThemeIssue[] = [];
  const entries = scanUserThemeFiles(env, issues).map((scanned) => ({
    stem: scanned.file.name,
    layer: scanned.layer,
  }));
  return { entries, issues };
}

/**
 * The UNCONVERTED source stems (the completion list). Retired sources
 * and outputs are absent.
 *
 * @param env - The environment.
 * @returns The convertible stems.
 */
export function listConvertCandidates(env: ThemeEnv): string[] {
  return listConvertCandidateEntries(env).entries.map((entry) => entry.stem);
}

/** One conversion outcome. */
type ConvertResult =
  | { ok: true; stem: string }
  | { ok: false; stem: string; reason: "not-found" | "invalid" };

/**
 * Convert the named source stems (the `/pigment convert <stem>` path —
 * direct and picked alike) through the converter and write the outputs
 * next to their sources. A retired source (an output already exists)
 * never reaches here (scanUserThemeFiles excludes it), so every
 * conversion writes fresh. A bundled-name collision refuses registration
 * (the split-brain look is worse than a rename request).
 *
 * @param env - The environment.
 * @param stems - The source stems to convert (project layer wins shadows).
 * @returns The per-stem results and the issues (never fatal).
 */
export function convertThemes(
  env: ThemeEnv,
  stems: string[],
): { results: ConvertResult[]; issues: ThemeIssue[] } {
  const issues: ThemeIssue[] = [];
  const loadable = new Map(
    scanUserThemeFiles(env, issues).map((scanned) => [scanned.file.name, scanned] as const),
  );
  const results = stems.map((stem) => {
    const scanned = loadable.get(stem);
    if (!scanned) return { ok: false, stem, reason: "not-found" } as const;
    const file = scanned.file;
    const piName = piNameForUserStem(stem);
    if (isBundledThemeName(stem)) {
      issues.push({
        message: `The theme file "${scanned.fileName}" collides with a bundled theme of the same name — rename the file to register it.`,
        sourcePath: stem,
      });
      return { ok: false, stem, reason: "invalid" } as const;
    }
    // The user channel converts with the AA sweep OFF (enforceAa: false):
    // the author's colors land in the output verbatim — the same boundary
    // the runtime applies (colors YOU set render verbatim; the bundled
    // ships are pi-pigment's own and keep their generation-time sweep).
    const { doc, issues: convertIssues } = convertToPiTheme(file.theme, piName, {
      enforceAa: false,
      diff: {
        added: file.diffRoots?.added?.text,
        removed: file.diffRoots?.removed?.text,
        addedTint: file.diffRoots?.added?.tint,
        removedTint: file.diffRoots?.removed?.tint,
      },
    });
    for (const issue of convertIssues) {
      issues.push({ message: issue.message, sourcePath: stem });
    }
    if (!doc) {
      return { ok: false, stem, reason: "invalid" } as const;
    }
    // The output lands next to the source — in the layer where the source
    // lives (project sources write project outputs; the shadowing layers
    // stay untouched).
    const outDir = sourceDirOf(env, stem) ?? themeDirs(env)[1];
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, outputFileName(stem)), `${JSON.stringify(doc, null, "\t")}\n`);
    return { ok: true, stem } as const;
  });
  return { results, issues };
}

/**
 * The directory holding a source stem (project layer first).
 *
 * @param env - The environment.
 * @param stem - The source stem.
 * @returns The directory path, or undefined when absent everywhere.
 */
function sourceDirOf(env: ThemeEnv, stem: string): string | undefined {
  for (const dir of themeDirs(env)) {
    for (const [s] of scanThemesDir(dir)?.sources ?? []) {
      if (s === stem) return dir;
    }
  }
  return undefined;
}

/**
 * List the conversion OUTPUTS across the config layers (project-first
 * shadowing) — the files pi registers. This is the resources_discover
 * product: pure listing, no conversion, no startup tax.
 *
 * @param env - The environment.
 * @returns The output file paths (existing files only).
 */
export function listConvertedThemes(env: ThemeEnv): string[] {
  const byStem = new Map<string, string>();
  for (const dir of themeDirs(env)) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!isOutputFile(name)) continue;
      const stem = name.slice(PIGMENT_PREFIX.length, -".json".length);
      if (!byStem.has(stem)) byStem.set(stem, join(dir, name));
    }
  }
  return [...byStem.values()];
}

/**
 * Populate the ours-detection registry from the outputs + sources: an
 * output pigment-X with a live source X maps to the precise pipeline.
 *
 * @param env - The environment.
 */
export function registerConvertedThemes(env: ThemeEnv): void {
  for (const outPath of listConvertedThemes(env)) {
    const name = basename(outPath).replace(/\.json$/, "");
    const stem = name.slice(PIGMENT_PREFIX.length);
    // The precise pipeline needs the SOURCE; without it the output stands
    // alone (external theme — not registered here).
    const source = findSourcePath(env, stem);
    if (source !== undefined) registerUserTheme(stem, name);
  }
}

/**
 * Locate a source file by stem across the layers (project first).
 *
 * @param env - The environment.
 * @param stem - The source stem.
 * @returns The file path, or undefined when absent.
 */
function findSourcePath(env: ThemeEnv, stem: string): string | undefined {
  for (const dir of themeDirs(env)) {
    for (const ext of THEME_FILE_EXTS) {
      const candidate = join(dir, `${stem}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Reload a user theme by stem (the precise pipeline's input — the
 * render-time counterpart of the registry's source mapping).
 *
 * @param stem - The theme file stem.
 * @param env - The environment (defaults to the session's; see below).
 * @returns The materialized theme, or undefined when unreadable.
 */
export function loadUserTheme(stem: string, env?: ThemeEnv): MaterializedTheme | undefined {
  const theEnv = env ?? currentEnv;
  if (!theEnv) return undefined;
  const path = findSourcePath(theEnv, stem);
  if (!path) return undefined;
  return loadThemeFile(path, [])?.theme;
}

/** The last-seen environment (set per session_start; the lazy reload seam). */
let currentEnv: ThemeEnv | undefined;

/**
 * Record the session's environment for the lazy user-theme reloads
 * (render time has no env of its own).
 *
 * @param env - The environment.
 */
export function setUserThemeEnv(env: ThemeEnv): void {
  currentEnv = env;
}

/**
 * The session's recorded environment, or undefined before the first
 * session_start. The command's completions prefer this over
 * `process.cwd()` — the session cwd is the truth any remote/RPC mode's
 * process may not share.
 *
 * @returns The recorded environment, or undefined.
 */
export function getUserThemeEnv(): ThemeEnv | undefined {
  return currentEnv;
}
