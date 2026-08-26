/**
 * The config-layer module: loads the layered config (global then project,
 * `config.jsonc`/`config.json`, JSONC tolerant) and persists the effective
 * config back into a layer. The project layer's trust rule closes here,
 * on both sides: reads skip it when untrusted, writes refuse it — callers
 * can't bypass the guard.
 *
 * Fail-safe: a malformed file is skipped with a recorded issue, an invalid
 * merged config yields `{ config: undefined }` (no registration — a config
 * error degrades to no auto-review, never to a wrong deny), and a save
 * never writes an invalid snapshot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type ParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser";

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

/**
 * The environment the config layer resolves paths and trust from — the ONE
 * vocabulary both load and persist share. `trustedProject` gates the
 * project layer identically on read (skip) and write (refuse).
 */
export interface ConfigEnv {
  /** Project working directory (also the project-layer root). */
  cwd: string;
  /** Whether the project layer is honored (mirrors isProjectTrusted()). */
  trustedProject: boolean;
  /** Explicit agent directory (test seam); defaults to getAgentDir(). */
  agentDir?: string;
}

/** A config layer the save action can target. */
export type ConfigLayerTarget = "global" | "project";

/** The shared save seam: persist a config snapshot into a layer. */
export type SaveConfigFn = (target: ConfigLayerTarget, config: AiGuardConfig) => SaveConfigResult;

/** Result of persisting the effective config into a config layer. */
export interface SaveConfigResult {
  /** The file that was written (or would have been). */
  path: string;
  /** True when the file did not exist and was created. */
  created: boolean;
  /** True when at least one field changed and was written. */
  changed: boolean;
  /** Refusal reason — nothing was written. */
  error?: string;
}

/** A failed parse of a layer file, classified for each side's own verdict. */
type LayerParseFailure =
  | { kind: "parse"; code: ParseError["error"]; offset: number }
  | { kind: "root" };

/** Candidate config file names, in discovery order (`.jsonc` preferred). */
const CONFIG_FILE_NAMES = ["config.jsonc", "config.json"] as const;

/** The file name created when no config exists yet. */
const CREATE_FILE_NAME = CONFIG_FILE_NAMES[0];

/** Sentinel distinguishing "path absent" from a legitimately undefined value. */
const MISSING = Symbol("missing");

/**
 * Resolve the agent config directory.
 *
 * `getAgentDir()` honors `PI_CODING_AGENT_DIR` (the `ENV_AGENT_DIR` env var)
 * and falls back to `~/.pi/agent` (respecting rebranded `CONFIG_DIR_NAME`).
 * Allow an override in tests via `ConfigEnv.agentDir`.
 *
 * @param env - The environment (its agentDir override wins, else getAgentDir()).
 * @returns The resolved agent config directory path.
 */
function resolveAgentDir(env: ConfigEnv): string {
  return env.agentDir ?? getAgentDir();
}

function getGlobalConfigDir(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID);
}

function getGlobalConfigPath(agentDir: string): string {
  return join(getGlobalConfigDir(agentDir), CREATE_FILE_NAME);
}

/**
 * Project-local config path. Uses `CONFIG_DIR_NAME` (e.g. `.pi`) rather than
 * hardcoding, so rebranded distributions resolve correctly.
 *
 * @param cwd - The project working directory.
 * @returns The project-local config file path.
 */
function getProjectConfigDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_ID);
}

function getProjectConfigPath(cwd: string): string {
  return join(getProjectConfigDir(cwd), CREATE_FILE_NAME);
}

/**
 * Locate the layer's config file. Discovery order: `config.jsonc` first,
 * then `config.json` (dual presence is ambiguous — `.jsonc` wins via the
 * ??= floor). The single discovery implementation, shared by the read side
 * (which warns on ambiguity) and the write side (which edits whichever
 * candidate exists).
 *
 * @param dir - The layer directory.
 * @returns The resolved file, or undefined when no config exists yet.
 */
function resolveLayerFile(dir: string): { path: string; ambiguous: boolean } | undefined {
  let path: string | undefined;
  let found = 0;
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      found += 1;
      path ??= candidate;
    }
  }
  return path ? { path, ambiguous: found > 1 } : undefined;
}

/**
 * Parse a layer file's text as tolerant JSONC with an object root — the
 * single parse-and-validity implementation. Each side renders its own
 * verdict (issue-and-skip on read, refuse on write) over this fact.
 *
 * @param text - The file text.
 * @returns The parsed object, or the classified failure.
 */
function parseLayerText(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; failure: LayerParseFailure } {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  const first = errors.at(0);
  if (first) {
    return { ok: false, failure: { kind: "parse", code: first.error, offset: first.offset } };
  }
  if (!isObjectRecord(parsed)) {
    return { ok: false, failure: { kind: "root" } };
  }
  return { ok: true, value: parsed };
}

function readLayer(dir: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  const found = resolveLayerFile(dir);
  if (!found) {
    return undefined;
  }
  const { path } = found;
  if (found.ambiguous) {
    issues.push({
      path: "$",
      message: `Both ${CONFIG_FILE_NAMES.join(" and ")} exist — using ${basename(path)}.`,
      sourcePath: path,
    });
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ path: "$", message: `Failed to read config: ${message}`, sourcePath: path });
    return undefined;
  }
  const parsed = parseLayerText(text);
  if (!parsed.ok) {
    const message =
      parsed.failure.kind === "parse"
        ? `Failed to read config: ${printParseErrorCode(parsed.failure.code)} at offset ${parsed.failure.offset}`
        : "Expected a JSON object.";
    issues.push({ path: "$", message, sourcePath: path });
    return undefined;
  }
  return parsed.value;
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

/**
 * Read the value at a JSONPath from a plain parsed object.
 *
 * @param root - The parsed object to walk.
 * @param path - The property path (root-level outward).
 * @returns The value at the path, or {@link MISSING} when absent.
 */
function readPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isObjectRecord(current) || !(key in current)) {
      return MISSING;
    }
    current = current[key];
  }
  return current;
}

/**
 * Enumerate the leaf paths of a plain nested object: scalars and arrays are
 * leaves, plain objects recurse. The zod-parsed config's key order is
 * stable, so edits apply in a deterministic sequence.
 *
 * @param value - The object to walk.
 * @param path - The accumulated property path.
 * @returns Leaf entries (path + value).
 */
function leafPaths(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (isObjectRecord(value)) {
    const leaves: Array<{ path: string[]; value: unknown }> = [];
    for (const key of Object.keys(value)) {
      leaves.push(...leafPaths(value[key], [...path, key]));
    }
    return leaves;
  }
  return [{ path, value }];
}

export function loadAiGuardConfig(env: ConfigEnv): LoadConfigResult {
  const agentDir = resolveAgentDir(env);
  const issues: ConfigIssue[] = [];

  const global = readLayer(getGlobalConfigDir(agentDir), issues);
  // Untrusted projects skip the project layer — a project-local config
  // must not influence the reviewer when the project itself isn't trusted.
  const project = env.trustedProject ? readLayer(getProjectConfigDir(env.cwd), issues) : undefined;

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

/**
 * Persist the current EFFECTIVE config into a config layer — the explicit
 * menu actions "save to global config" / "save to project config". The
 * snapshot is written leaf-by-leaf via jsonc-parser's modify: only leaves
 * whose value differs from the target file change, so user formatting,
 * comments, and untouched keys survive byte-for-byte. A new file is
 * created with the complete snapshot.
 *
 * Guardrails, all inside this interface:
 * - Refuses the `project` target when the project is untrusted (that
 * layer isn't honored for reads either — saving there would write a
 * config that never applies and masquerade as success).
 * - Validates the snapshot against the zod schema before any write: an
 * invalid snapshot refuses; unknown keys are stripped and the CANONICAL
 * parse output is what lands in the file.
 *
 * @param options - The target layer, the environment, and the snapshot.
 * @returns The path (+ created/changed flags), or an error with no write.
 */
export function persistConfigLayer(options: {
  target: ConfigLayerTarget;
  env: ConfigEnv;
  config: AiGuardConfig;
}): SaveConfigResult {
  const { target, env, config } = options;
  // Refuse before ANY filesystem work: a save into an unhonored layer
  // must not even touch the disk.
  if (target === "project" && !env.trustedProject) {
    return {
      path: "",
      created: false,
      changed: false,
      error: "the project is untrusted — project config isn't honored here",
    };
  }
  const canonical = configSchema.safeParse(config);
  if (!canonical.success) {
    const first = canonical.error.issues[0];
    return {
      path: "",
      created: false,
      changed: false,
      error: `the snapshot is invalid — ${first?.path.join(".") || "$"}: ${first?.message}`,
    };
  }
  const agentDir = resolveAgentDir(env);
  const dir = target === "global" ? getGlobalConfigDir(agentDir) : getProjectConfigDir(env.cwd);
  const createPath =
    target === "global" ? getGlobalConfigPath(agentDir) : getProjectConfigPath(env.cwd);
  // Edit whichever candidate exists (jsonc-first); otherwise create .jsonc.
  const path = resolveLayerFile(dir)?.path ?? createPath;

  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(canonical.data, null, 2)}\n`, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { path, created: false, changed: false, error: message };
    }
    return { path, created: true, changed: true };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, created: false, changed: false, error: message };
  }

  // Validity gate: never edit a file the loader itself would skip.
  const parsed = parseLayerText(text);
  if (!parsed.ok) {
    const file = basename(path);
    const message =
      parsed.failure.kind === "parse"
        ? `${file} is not valid JSONC — ${printParseErrorCode(parsed.failure.code)} at offset ${parsed.failure.offset}`
        : `${file} root is not a JSON object`;
    return { path, created: false, changed: false, error: message };
  }
  const current = parsed.value;

  // Leaf-by-leaf diff: apply each changed leaf sequentially against the
  // running text, so jsonc-parser edits never overlap.
  let running = text;
  let changed = false;
  for (const { path: leafPath, value } of leafPaths(canonical.data)) {
    const previous = readPath(current, leafPath);
    if (previous === MISSING || !isDeepStrictEqual(previous, value)) {
      let edits;
      try {
        edits = modify(running, leafPath, value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        });
      } catch {
        // jsonc-parser's setProperty THROWS when a leaf's parent is a
        // scalar in the existing file ("Can not add index to parent of
        // type number") — a structural conflict must refuse, not corrupt.
        // (Non-delete modifies never return zero edits: they either do
        // the edit or throw — so a differing leaf after a successful
        // modify always landed.)
        return {
          path,
          created: false,
          changed: false,
          error: "refusing to write — the target file's shape conflicts with the current config",
        };
      }
      running = applyEdits(running, edits);
      changed = true;
    }
  }

  if (!changed) {
    return { path, created: false, changed: false };
  }
  // Final integrity gate: the EDITED text must parse, satisfy the schema,
  // AND carry every snapshot leaf. The schema check alone can't catch a
  // duplicate-key file: parse (and readPath) see the LAST occurrence while
  // jsonc-parser edits the FIRST — so `{"mode":"auto","mode":"manual"}`
  // "saved" mode:default would still read back "manual" on the next load.
  // Per-leaf equality makes a save that won't win refuse instead of
  // reporting success.
  const finalParsed = parseLayerText(running);
  if (!finalParsed.ok || !configSchema.safeParse(finalParsed.value).success) {
    return {
      path,
      created: false,
      changed: false,
      error: "refusing to write — the target file's shape conflicts with the current config",
    };
  }
  for (const { path: leafPath, value } of leafPaths(canonical.data)) {
    const saved = readPath(finalParsed.value, leafPath);
    if (saved === MISSING || !isDeepStrictEqual(saved, value)) {
      return {
        path,
        created: false,
        changed: false,
        error:
          "refusing to write — duplicate keys in the target file would shadow the saved values",
      };
    }
  }
  try {
    writeFileSync(path, running, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, created: false, changed: false, error: message };
  }
  return { path, created: false, changed: true };
}
