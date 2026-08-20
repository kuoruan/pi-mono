/**
 * Layered config loader: global then project `config.json`, project overriding
 * global, validated once against the zod schema.
 *
 * Fail-safe: a malformed file is skipped with a recorded issue, and an
 * invalid merged config yields `{ config: undefined }` so the extension
 * registers no link — a config error degrades to no auto-review, never
 * to a wrong deny.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { type AiGuardConfig, EXTENSION_ID, configSchema } from "./config-schema.ts";
import { isObjectRecord } from "./utils.ts";

/** A single validation or read error from config loading. */
export interface ConfigIssue {
  /** JSON path where the error occurred (e.g. "$", "circuitBreaker.consecutive"). */
  path: string;
  /** Human-readable error message. */
  message: string;
  /** File path that produced the issue, or undefined for merged-config errors. */
  sourcePath?: string;
}

/** Result of loading and validating the layered config. */
export interface LoadConfigResult {
  /** Validated config, or absent if loading failed (fail-safe: no auto-review). */
  config?: AiGuardConfig;
  /** All issues encountered (malformed files, schema violations). */
  issues: ConfigIssue[];
}

const CONFIG_FILE_NAME = "config.json";

/**
 * Resolve the agent config directory.
 *
 * `getAgentDir()` honors `PI_CODING_AGENT_DIR` (the `ENV_AGENT_DIR` env var)
 * and falls back to `~/.pi/agent` (respecting rebranded `CONFIG_DIR_NAME`).
 * Allow an override in tests via the `agentDir` option.
 *
 * @param override - Optional explicit agent directory (used in tests).
 * @returns The resolved agent config directory path.
 */
function resolveAgentDir(override?: string): string {
  return override ?? getAgentDir();
}

function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, CONFIG_FILE_NAME);
}

/**
 * Project-local config path. Uses `CONFIG_DIR_NAME` (e.g. `.pi`) rather than
 * hardcoding, so rebranded distributions resolve correctly.
 *
 * @param cwd - The project working directory.
 * @returns The project-local config file path.
 */
function getProjectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_ID, CONFIG_FILE_NAME);
}

function readLayer(path: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isObjectRecord(parsed)) {
      issues.push({ path: "$", message: "Expected a JSON object.", sourcePath: path });
      return undefined;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ path: "$", message: `Failed to read config: ${message}`, sourcePath: path });
    return undefined;
  }
}

/**
 * Deep merge two plain objects. `target` is the base, `source` overrides.
 * - Plain objects are merged recursively.
 * - Arrays, null, and other values are replaced (source wins).
 * - Does not mutate either argument — returns a new object.
 *
 * @param target - The base object.
 * @param source - The overriding object (source wins on conflicts).
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
    if (isObjectRecord(tv) && isObjectRecord(sv)) {
      result[key] = deepMerge(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export function loadAiGuardConfig(options?: {
  cwd?: string;
  agentDir?: string;
  /**
   * Whether project-local config should be honored. When false, the project
   * layer is skipped so an untrusted project's `.pi/extensions/...` config
   * cannot influence the reviewer.
   */
  trustedProject?: boolean;
}): LoadConfigResult {
  const cwd = options?.cwd ?? process.cwd();
  const agentDir = resolveAgentDir(options?.agentDir);
  const issues: ConfigIssue[] = [];

  const global = readLayer(getGlobalConfigPath(agentDir), issues);
  const project =
    options?.trustedProject === false ? undefined : readLayer(getProjectConfigPath(cwd), issues);

  if (global === undefined && project === undefined) {
    return { issues };
  }

  // Deep merge: project overrides global. Plain objects are merged recursively
  // so a project can override a single field of a nested object (e.g.
  // transcript.maxUserMessages) without repeating the rest. Arrays and
  // non-object values are replaced wholesale.
  const merged: Record<string, unknown> =
    global && project ? deepMerge(global, project) : (global ?? project ?? {});

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: issue.path.join(".") || "$", message: issue.message });
    }
    return { issues };
  }

  // A legal but surprising combination: in `auto` mode a breaker configured
  // to force `defer` will interrupt the human when the reviewer is untrusted
  // (the designed escape valve — specific config beats the mode). Surface it
  // as a warning so the interaction is visible without opening the docs.
  if (parsed.data.mode === "auto" && parsed.data.circuitBreaker.verdict === "defer") {
    issues.push({
      path: "mode",
      message:
        'mode "auto" + circuitBreaker.verdict "defer": the breaker interrupts the human when it trips (reviewer untrusted escape valve).',
    });
  }

  return { config: parsed.data, issues };
}
