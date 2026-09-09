/**
 * The config layer: loads the two-layer `config.jsonc` (global then project,
 * JSONC-tolerant) and merges it with project overriding global. Modeled on
 * pi-permission-ai-guard's config-layer with two deliberate omissions (the
 * config is cosmetic — ADR 0001): no project trust gating and no persistence.
 *
 * Fail-safe: a malformed or invalid layer is skipped with a recorded issue
 * and the other layer still applies; with no valid layer at all the
 * schema defaults stand.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

import { configSchema, CONFIG_HOME, type PigmentConfig } from "./config-schema.ts";

/** A single validation or read issue from config loading. */
interface ConfigIssue {
  /** Human-readable message. */
  message: string;
  /** File path that produced the issue. */
  sourcePath?: string;
}

/** Result of loading and validating the layered config. */
interface LoadConfigResult {
  /** Validated config — always present (schema defaults when no layer applies). */
  config: PigmentConfig;
  /** All issues encountered (missing files are not issues). */
  issues: ConfigIssue[];
}

/** The environment the config layer resolves paths from. */
interface ConfigEnv {
  /** Project working directory (the project-layer root). */
  cwd: string;
  /** Explicit agent directory (test seam); defaults to getAgentDir(). */
  agentDir?: string;
}

/** Candidate config file names, in discovery order (`config.jsonc` preferred). */
const CONFIG_FILE_NAMES = ["config.jsonc", "config.json"] as const;

/**
 * Global layer directory. The agent dir ALREADY sits under the config
 * dir (`~/.pi/agent` — getAgentDir joins home + CONFIG_DIR_NAME + "agent"),
 * so unlike the project root it takes NO extra `.pi` segment: pi's own
 * resource loader reads `join(agentDir, "extensions")`.
 *
 * @param agentDir - The resolved agent directory.
 * @returns The global layer's config directory.
 */
function globalConfigDir(agentDir: string): string {
  return join(agentDir, "extensions", CONFIG_HOME);
}

/**
 * Project layer directory — the cwd DOES need the config-dir segment
 * (`<cwd>/.pi/extensions/pigment/`).
 *
 * @param cwd - The project working directory.
 * @returns The project layer's config directory.
 */
function projectConfigDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_HOME);
}

/**
 * Locate a layer's config file: `config.jsonc` first, then `config.json`.
 *
 * @param dir - The layer directory.
 * @returns The config file path, or undefined when the layer has none.
 */
function resolveLayerFile(dir: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Whether a JSONC root is a plain object (not array/string/number/null) —
 * the shape a config layer must have.
 *
 * @param v - The parsed root.
 * @returns True when the root is a record.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A config layer — the two-layer hierarchy every config-rooted directory
 * mirrors (config files, themes/): the project layer (the cwd's `.pi/`)
 * shadows the global layer (the agent dir).
 */
export type ConfigLayer = "global" | "project";

/**
 * A layer read: parsed object, or an issue to record.
 *
 * @param dir - The layer directory.
 * @param layer - Which layer, for issue messages.
 * @param issues - The issue accumulator.
 * @returns The parsed layer object, or undefined when absent/invalid.
 */
function readLayer(
  dir: string,
  layer: ConfigLayer,
  issues: ConfigIssue[],
): Record<string, unknown> | undefined {
  const path = resolveLayerFile(dir);
  if (!path) return undefined;

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ message: `Failed to read the ${layer} config: ${message}`, sourcePath: path });
    return undefined;
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  const first = errors.at(0);
  if (first) {
    issues.push({
      message: `The ${layer} config is not valid JSONC — ${printParseErrorCode(first.error)} at offset ${first.offset}; it was skipped.`,
      sourcePath: path,
    });
    return undefined;
  }
  if (!isRecord(parsed)) {
    issues.push({
      message: `The ${layer} config root must be a JSON object; it was skipped.`,
      sourcePath: path,
    });
    return undefined;
  }
  // The `$schema` key is the JSONC editor-association convention (README
  // suggests it for completion); it describes the file, not the config, so
  // it is stripped at the boundary rather than validated.
  const { $schema: _editor, ...config } = parsed;
  return config;
}

/**
 * Deep merge two plain objects: plain objects merge recursively, arrays and
 * scalars are replaced (source wins). Neither argument is mutated.
 *
 * @param target - The base object.
 * @param source - The overriding object.
 * @returns A new merged object.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      typeof tv === "object" &&
      tv !== null &&
      !Array.isArray(tv) &&
      typeof sv === "object" &&
      sv !== null &&
      !Array.isArray(sv)
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

/**
 * Load the effective config: both layers, deep-merged (project overrides
 * global), schema-validated. Issues are recorded per layer; the
 * `syntaxTheme` key falls back to "auto" alone when it fails validation
 * (the object form is error-prone — a typo must not take down
 * `disabledTools`/`indicatorStyle` too); any OTHER key failing keeps the
 * whole-config defaults — a config error never disables the renderer.
 *
 * @param env - The environment (cwd + agentDir test seam).
 * @returns The effective config and any recorded issues.
 */
export function loadPigmentConfig(env: ConfigEnv): LoadConfigResult {
  const agentDir = env.agentDir ?? getAgentDir();
  const issues: ConfigIssue[] = [];

  const global = readLayer(globalConfigDir(agentDir), "global", issues);
  const project = readLayer(projectConfigDir(env.cwd), "project", issues);

  let merged: Record<string, unknown>;
  if (global && project) {
    merged = deepMerge(global, project);
  } else {
    merged = global ?? project ?? {};
  }
  const parsed = configSchema.safeParse(merged);
  if (parsed.success) return { config: parsed.data, issues };

  const syntaxThemeIssue = parsed.error.issues.find((issue) => issue.path[0] === "syntaxTheme");
  if (!syntaxThemeIssue) {
    for (const issue of parsed.error.issues) {
      issues.push({
        message: `Invalid config at "${issue.path.join(".") || "$"}": ${issue.message} — defaults apply.`,
      });
    }
    return { config: configSchema.parse({}), issues };
  }

  // Single-key fallback: retry without syntaxTheme; the other keys survive.
  // The path names the offending sub-key (e.g. "syntaxTheme.diff.
  // added.tint") — "Invalid string" alone doesn't say WHICH
  // root was wrong.
  const where = syntaxThemeIssue.path.join(".");
  issues.push({
    message: `Invalid ${where || "syntaxTheme"}: ${syntaxThemeIssue.message} — it falls back to "auto" (other keys still apply).`,
  });
  const { syntaxTheme: _dropped, ...rest } = merged;
  const retried = configSchema.safeParse(rest);
  if (!retried.success) {
    for (const issue of retried.error.issues) {
      issues.push({
        message: `Invalid config at "${issue.path.join(".") || "$"}": ${issue.message} — defaults apply.`,
      });
    }
    return { config: configSchema.parse({}), issues };
  }
  return { config: retried.data, issues };
}
