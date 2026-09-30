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
  type ParseErrorCode,
  type ParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser";
import type { z } from "zod";

import { errorMessage, isObjectRecord } from "#src/utils.ts";

import { type AiGuardConfig, EXTENSION_ID, configSchema } from "./config-schema.ts";
import { modeWarnings } from "./mode-table.ts";

/** A single validation or read error from config loading. */
export interface ConfigIssue {
  /** JSON path where the error occurred (e.g. "$", "circuitBreaker.consecutive"). */
  path: string;
  /** Human-readable error message. */
  message: string;
  /** File path that produced the issue, or undefined for merged-config errors. */
  sourcePath?: string;
}

/** How a config load resolved — assigned at each decision point, never derived. */
export type ConfigOutcome =
  /** Config loaded (issues may still carry warnings). */
  | "loaded"
  /** No config anywhere (issues empty); distinct from a broken file. */
  | "none"
  /** Config exists but unusable (issues explain why); fail-safe, no auto-review. */
  | "failed";

/** Result of loading and validating the layered config. */
export interface LoadConfigResult {
  /** Validated config, or absent if loading failed (fail-safe: no auto-review). */
  config?: AiGuardConfig;
  /** All issues encountered (malformed files, schema violations). */
  issues: ConfigIssue[];
  /** How the load resolved — the fail-safe notice consumes this, not issue counts. */
  outcome: ConfigOutcome;
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
  | { kind: "parse"; code: ParseErrorCode; offset: number }
  | { kind: "root"; code?: never; offset?: never };

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

/** A config-layer file, when both names exist the jsonc one wins (with a warning). */
interface LayerFile {
  path: string;
  ambiguous: boolean;
}

/** A layer file read: parsed object, or a tagged failure to surface upstream. */
type ReadLayerResult =
  | { ok: true; value: Record<string, unknown>; failure?: never }
  | { ok: false; failure: LayerParseFailure; value?: never };

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
function resolveLayerFile(dir: string): LayerFile | undefined {
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
function parseLayerText(text: string): ReadLayerResult {
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

/**
 * How a layer read resolved. The caller matches on this — never on
 * whether issues accumulated — to tell "no file" from "broken file".
 */
type LayerReadOutcome =
  /** No file in the layer directory. */
  | "absent"
  /** File read and usable. */
  | "loaded"
  /** File exists but unusable (issue already pushed). */
  | "skipped";

/** A layer read: the parsed value (when usable) plus how it resolved. */
interface LayerReadResult {
  /** The parsed layer object; absent unless the outcome is `loaded`. */
  value?: Record<string, unknown>;
  outcome: LayerReadOutcome;
}

/**
 * Read one config layer: locate the file (`config.jsonc` wins),
 * parse it as tolerant JSONC, and expand `${VAR}` refs in its string
 * leaves. Any failure pushes a file-attributed issue and resolves as
 * `skipped` — only a missing file is `absent`.
 *
 * @param dir - The layer directory to read.
 * @param issues - Issues accumulator (file-attributed entries).
 * @param vars - The variable source for env-ref expansion.
 * @returns The parsed value plus how the read resolved.
 */
function readLayer(
  dir: string,
  issues: ConfigIssue[],
  vars: Record<string, string | undefined>,
): LayerReadResult {
  const found = resolveLayerFile(dir);
  if (!found) {
    return { outcome: "absent" };
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
    issues.push({
      path: "$",
      message: `Failed to read config: ${errorMessage(error)}`,
      sourcePath: path,
    });
    return { outcome: "skipped" };
  }
  const parsed = parseLayerText(text);
  if (!parsed.ok) {
    const message =
      parsed.failure.kind === "parse"
        ? `Failed to read config: ${printParseErrorCode(parsed.failure.code)} at offset ${parsed.failure.offset}`
        : "Expected a JSON object.";
    issues.push({ path: "$", message, sourcePath: path });
    return { outcome: "skipped" };
  }
  // Env refs expand here, inside the layer: sourcePath and leaf paths
  // are both known, and an unresolvable ref skips just this layer.
  if (!expandLayerEnvRefs(parsed.value, vars, path, issues)) {
    return { outcome: "skipped" };
  }
  return { value: parsed.value, outcome: "loaded" };
}

/**
 * Environment-variable interpolation for config string values: `${NAME}`
 * expands to the variable's value, `${NAME:-fallback}` uses the fallback
 * when the variable is unset or empty, and `$$` escapes to a literal `$`.
 * Anything else is literal — `$NAME` (no braces), `${NAME:?…}`, and
 * command substitution are NOT supported by design.
 *
 * @param value - The string value to expand.
 * @param vars - The variable source (production passes `process.env`).
 * @returns The expanded string, or undefined when a referenced variable
 *   has no value and no fallback (the caller skips the layer).
 */
export function expandEnvRefs(
  value: string,
  vars: Record<string, string | undefined>,
): string | undefined {
  // `$$` is an escape for a literal `$` — fold it first behind a
  // sentinel so `${` scanning never sees through it (else `$${A}`
  // would expand A instead of yielding the literal `${A}`).
  const ESC = "\0";
  const src = value.replaceAll("$$", ESC);
  let out = "";
  let rest = src;
  const done = (s: string): string => s.replaceAll(ESC, "$");
  for (;;) {
    const start = rest.indexOf("${");
    if (start < 0) return done(out + rest);
    const end = rest.indexOf("}", start + 2);
    if (end < 0) return done(out + rest);
    out += rest.slice(0, start);
    const expr = rest.slice(start + 2, end);
    rest = rest.slice(end + 1);
    const fallbackAt = expr.indexOf(":-");
    const name = fallbackAt < 0 ? expr : expr.slice(0, fallbackAt);
    const fallback = fallbackAt < 0 ? undefined : expr.slice(fallbackAt + 2);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "")) {
      out += "${" + expr + "}";
      continue;
    }
    const found = vars[name as string];
    if (found !== undefined && found !== "") {
      out += found;
    } else if (fallback !== undefined) {
      out += done(fallback);
    } else {
      return undefined;
    }
  }
}

/**
 * Whether a disk leaf counts as equal to a snapshot leaf: identical, or
 * an env ref expanding to the snapshot value (an untouched placeholder
 * still reads as ref text — without this the expanded secret would
 * overwrite the placeholder on write-back).
 *
 * @param previous - The leaf value read from disk.
 * @param value - The snapshot leaf value.
 * @param vars - The variable source for env-ref equivalence.
 * @returns True when the leaf needs no write.
 */
export function leafEquals(
  previous: unknown,
  value: unknown,
  vars: Record<string, string | undefined>,
): boolean {
  if (Array.isArray(previous) && Array.isArray(value)) {
    return (
      previous.length === value.length &&
      previous.every((item, index) => leafEquals(item, value[index], vars))
    );
  }
  if (isObjectRecord(previous) && isObjectRecord(value)) {
    const previousKeys = Object.keys(previous);
    return (
      previousKeys.length === Object.keys(value).length &&
      previousKeys.every((key) => key in value && leafEquals(previous[key], value[key], vars))
    );
  }
  return (
    isDeepStrictEqual(previous, value) ||
    (typeof previous === "string" && expandEnvRefs(previous, vars) === value)
  );
}

/**
 * Restore `${VAR}` placeholders into an expanded snapshot subtree.
 * Persist compares the on-disk tree (placeholders intact) against the
 * in-memory snapshot (refs already expanded): without restoration a
 * changed array leaf would write back expanded secrets, destroying the
 * placeholders. Elements resolving to the snapshot value revert to the
 * on-disk text; everything else keeps the snapshot value. A ref whose
 * variable vanished since load (env drift) also reverts to the on-disk
 * text — the placeholder is the operator's intent, and the integrity
 * gate refuses the write if it no longer matches the snapshot.
 *
 * @param previous - The subtree read from disk.
 * @param value - The snapshot subtree.
 * @param vars - The variable source for env-ref equivalence.
 * @returns The value to write back.
 */
function restorePlaceholders(
  previous: unknown,
  value: unknown,
  vars: Record<string, string | undefined>,
): unknown {
  if (typeof previous === "string") {
    if (expandEnvRefs(previous, vars) === value) return previous;
    // Env drift (or an edited value over a placeholder): never write the
    // snapshot's expanded secret over a ref the operator left on disk.
    if (previous.includes("${")) return previous;
    return value;
  }
  if (Array.isArray(previous) && Array.isArray(value)) {
    // Content matching, not positional: prepend/reorder must still find
    // each element's on-disk placeholder. Each disk element is spent once.
    const unused = [...previous];
    return value.map((item) => {
      const hit = unused.findIndex((candidate) => leafEquals(candidate, item, vars));
      if (hit === -1) return item;
      const [matched] = unused.splice(hit, 1);
      return restorePlaceholders(matched, item, vars);
    });
  }
  if (isObjectRecord(previous) && isObjectRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] =
        key in previous ? restorePlaceholders(previous[key], value[key], vars) : value[key];
    }
    return out;
  }
  return value;
}

/**
 * The single descent primitive: walk a parsed tree, calling `visit` on
 * each leaf. `arraysAsContainers` selects the leaf strategy — expansion
 * sees arrays as containers (env refs live inside `fallbacks[]`), while
 * persist sees them as atomic leaves (arrays are replaced wholesale).
 *
 * @param node - The current subtree.
 * @param path - The accumulated property path.
 * @param arraysAsContainers - Whether to descend into arrays.
 * @param visit - Called once per leaf with its value and path.
 */
function descend(
  node: unknown,
  path: string[],
  arraysAsContainers: boolean,
  visit: (value: unknown, path: string[]) => void,
): void {
  if (Array.isArray(node)) {
    if (!arraysAsContainers) {
      visit(node, path);
      return;
    }
    node.forEach((item, index) => descend(item, [...path, String(index)], true, visit));
    return;
  }
  if (isObjectRecord(node)) {
    for (const key of Object.keys(node))
      descend(node[key], [...path, key], arraysAsContainers, visit);
    return;
  }
  visit(node, path);
}

/**
 * Expand env refs in every string leaf of a parsed layer, in place.
 * Non-string leaves and object keys are untouched; a numeric field
 * holding `"${PORT}"` stays a string and fails zod type-check downstream.
 *
 * @param root - The parsed layer object to expand.
 * @param vars - The variable source.
 * @param sourcePath - The layer file (for issue attribution).
 * @param issues - Issues accumulator; one entry per unresolvable leaf.
 * @returns False when any leaf was unresolvable (the layer is skipped).
 */
function expandLayerEnvRefs(
  root: Record<string, unknown>,
  vars: Record<string, string | undefined>,
  sourcePath: string,
  issues: ConfigIssue[],
): boolean {
  let ok = true;
  descend(root, [], true, (node, path) => {
    if (typeof node !== "string" || !node.includes("${")) return;
    const expanded = expandEnvRefs(node, vars);
    if (expanded === undefined) {
      ok = false;
      issues.push({
        path: path.join(".") || "$",
        message: `env ref in "${node}" has no value and no fallback — set it or add :-`,
        sourcePath,
      });
      return;
    }
    if (expanded !== node) {
      setPath(root, path, expanded);
    }
  });
  return ok;
}

/**
 * Set the value at a JSONPath inside a parsed object (the write half of
 * {@link readPath}). Intermediate segments are known to be objects — the
 * walker above only descends through records and arrays.
 *
 * @param root - The object to modify in place.
 * @param path - The property path from the object root.
 * @param value - The value to set.
 */
function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current: Record<string, unknown> | unknown[] = root;
  for (const key of path.slice(0, -1)) {
    current = (current as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
  }
  const last = path[path.length - 1] as string;
  if (Array.isArray(current)) {
    current[Number(last)] = value;
  } else {
    (current as Record<string, unknown>)[last] = value;
  }
}

/**
 * Deep merge two plain objects. `target` is the base, `source` overrides.
 *
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

/** One leaf in a config object's path enumeration. */
interface LeafEntry {
  /** The property path from the object root to this leaf. */
  path: string[];
  /** The leaf's value (a scalar or an array). */
  value: unknown;
}

/**
 * Enumerate the leaf paths of a plain nested object, over the shared
 * {@link descend} primitive with the persist strategy (arrays are atomic
 * leaves). The zod-parsed config's key order is stable, so edits apply
 * in a deterministic sequence.
 *
 * @param value - The object to walk.
 * @param path - The accumulated property path.
 * @returns Leaf entries (path + value).
 */
export function leafPaths(value: unknown, path: string[] = []): LeafEntry[] {
  const leaves: LeafEntry[] = [];
  descend(value, path, false, (node, leafPath) => leaves.push({ path: leafPath, value: node }));
  return leaves;
}

/**
 * Flatten zod issues into path-qualified entries: the config schema is a
 * two-member union, and a union failure nests its members' issues —
 * surface the best member's (fewest issues) so paths stay qualified.
 *
 * Hand-rolled because zod's own utilities do not fit: `flattenError` /
 * `prettifyError` drop paths entirely, and `treeifyError` merges BOTH
 * members' issues per field (duplicated messages plus the other member's
 * unrelated provider error) in a tree this flat path/message list would
 * have to walk anyway.
 *
 * @param issues - The top-level zod issues from a failed parse.
 * @returns Path-qualified issues from the most plausible union member.
 */
function flattenZodIssues(issues: readonly z.core.$ZodIssue[]): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
      const members = issue.errors;
      const best = members.reduce((a, b) => (b.length < a.length ? b : a), members[0] ?? []);
      out.push(...flattenZodIssues(best));
    } else {
      out.push({ path: issue.path.join(".") || "$", message: issue.message });
    }
  }
  return out;
}

/**
 * Load the layered config: global then project (`config.jsonc` wins),
 * deep-merged (project overrides), `${VAR}` refs expanded per layer,
 * validated against the zod schema. The project layer is skipped when
 * untrusted — a present-but-ignored file is named as an issue so the
 * fail-safe notice doesn't claim no config exists. Fail-safe throughout:
 * an unusable layer degrades to no auto-review, never to a wrong deny.
 *
 * @param env - Paths and project trust for layer resolution.
 * @param vars - The variable source for env-ref expansion.
 * @returns The validated config (when usable), all issues, and how the
 *   load resolved (`none` only when both layers are file-absent).
 */
export function loadAiGuardConfig(
  env: ConfigEnv,
  vars: Record<string, string | undefined> = process.env,
): LoadConfigResult {
  const agentDir = resolveAgentDir(env);
  const issues: ConfigIssue[] = [];

  const global = readLayer(getGlobalConfigDir(agentDir), issues, vars);
  // Untrusted projects skip the project layer — a project-local config
  // must not influence the reviewer when the project itself isn't trusted.
  // Name the skip when a file actually exists there: otherwise the
  // fail-safe start reports "no config file found" while one sits ignored.
  let project: LayerReadResult;
  if (env.trustedProject) {
    project = readLayer(getProjectConfigDir(env.cwd), issues, vars);
  } else {
    const skipped = resolveLayerFile(getProjectConfigDir(env.cwd));
    if (skipped) {
      issues.push({
        path: "$",
        message: "project config ignored — the project is untrusted",
        sourcePath: skipped.path,
      });
      project = { outcome: "skipped" };
    } else {
      project = { outcome: "absent" };
    }
  }

  // `none` only when both layers are file-absent; any skipped layer
  // means config exists but is unusable — that's `failed`.
  if (global.outcome !== "loaded" && project.outcome !== "loaded") {
    const outcome = global.outcome === "absent" && project.outcome === "absent" ? "none" : "failed";
    return { issues, outcome };
  }

  // Deep merge: project overrides global. Plain objects are merged recursively
  // so a project can override a single field of a nested object (e.g.
  // transcript.maxUserMessages) without repeating the rest. Arrays and
  // non-object values are replaced wholesale.
  const merged: Record<string, unknown> =
    global.value && project.value
      ? deepMerge(global.value, project.value)
      : (global.value ?? project.value ?? {});

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    issues.push(...flattenZodIssues(parsed.error.issues));
    return { issues, outcome: "failed" };
  }

  // Ladder-owned surprise warnings (e.g. the extremes plus a breaker
  // forced to defer — the reviewer-untrusted escape valve interrupts the
  // human): the JSONC layer asks the ladder module instead of carrying
  // ladder semantics itself.
  issues.push(...modeWarnings(parsed.data));

  return { config: parsed.data, issues, outcome: "loaded" };
}

/**
 * What a persist call carries: the target layer, the environment (trust
 * boundary + agent dir), and the complete config snapshot to write.
 */
export interface PersistConfigOptions {
  /** The layer to write (global or project). */
  target: ConfigLayerTarget;
  /** The environment resolving layer paths and project trust. */
  env: ConfigEnv;
  /** The effective config snapshot to persist. */
  config: AiGuardConfig;
  /**
   * The variable source for env-ref equivalence (defaults to
   * `process.env`, mirroring {@link loadAiGuardConfig}).
   */
  vars?: Record<string, string | undefined>;
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
 *
 * - Refuses the `project` target when the project is untrusted (that layer isn't honored for reads
 *   either — saving there would write a config that never applies and masquerade as success).
 * - Validates the snapshot against the zod schema before any write: an invalid snapshot refuses;
 *   unknown keys are stripped and the CANONICAL parse output is what lands in the file.
 *
 * The two mutually exclusive results each live in their own helper:
 * {@link createLayerFile} (no file yet — write the snapshot whole) and
 * {@link editLayerFile} (existing file — the leaf diff and its refusal
 * gates).
 *
 * @param options - The target layer, the environment, and the snapshot.
 * @returns The path (+ created/changed flags), or an error with no write.
 */
export function persistConfigLayer(options: PersistConfigOptions): SaveConfigResult {
  const { target, env, config, vars = process.env } = options;
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
    const first = flattenZodIssues(canonical.error.issues)[0];
    return {
      path: "",
      created: false,
      changed: false,
      error: `the snapshot is invalid — ${first?.path || "$"}: ${first?.message}`,
    };
  }
  const agentDir = resolveAgentDir(env);
  const dir = target === "global" ? getGlobalConfigDir(agentDir) : getProjectConfigDir(env.cwd);
  const createPath =
    target === "global" ? getGlobalConfigPath(agentDir) : getProjectConfigPath(env.cwd);
  // Edit whichever candidate exists (jsonc-first); otherwise create .jsonc
  // (resolveLayerFile stat'ed both candidates, so a resolved path exists).
  const existing = resolveLayerFile(dir);
  if (!existing) {
    return createLayerFile(createPath, canonical.data);
  }
  const path = existing.path;

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return { path, created: false, changed: false, error: errorMessage(error) };
  }
  return editLayerFile(path, canonical.data, text, vars);
}

/**
 * The create branch of {@link persistConfigLayer}: no file exists yet, so
 * write the snapshot whole (fresh directory included). The two branches are
 * mutually exclusive results — a file is either created from nothing or
 * edited in place — and each owns its own error surface.
 *
 * @param path - The layer file path to create.
 * @param data - The validated config snapshot to write.
 * @returns The save result (`created: true` on success).
 */
function createLayerFile(path: string, data: AiGuardConfig): SaveConfigResult {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  } catch (error) {
    return { path, created: false, changed: false, error: errorMessage(error) };
  }
  return { path, created: true, changed: true };
}

/**
 * The edit branch of {@link persistConfigLayer}: an existing file is edited
 * in place, leaf by leaf, so comments and key order elsewhere in the file
 * survive. Three refusal gates (a file the loader would skip, a structural
 * conflict, duplicate keys that would shadow the saved values) plus the
 * final integrity check all live here.
 *
 * @param path - The existing layer file path.
 * @param data - The validated config snapshot to apply.
 * @param text - The file's current text.
 * @param vars - The variable source for env-ref equivalence.
 * @returns The save result (`changed: false` when already identical).
 */
function editLayerFile(
  path: string,
  data: AiGuardConfig,
  text: string,
  vars: Record<string, string | undefined>,
): SaveConfigResult {
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
  // Leaf-by-leaf diff: apply each changed leaf sequentially against the
  // running text, so jsonc-parser edits never overlap. Leaf equality
  // (including env-ref equivalence) lives in {@link leafEquals}.
  let running = text;
  let changed = false;
  for (const { path: leafPath, value } of leafPaths(data)) {
    const previous = readPath(parsed.value, leafPath);
    if (previous !== MISSING && leafEquals(previous, value, vars)) {
      continue;
    }
    // Write back with placeholders restored: an equivalent-but-expanded
    // leaf must not overwrite the on-disk `${VAR}` text with the secret.
    const writeValue = previous === MISSING ? value : restorePlaceholders(previous, value, vars);
    let edits;
    try {
      edits = modify(running, leafPath, writeValue, {
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
  for (const { path: leafPath, value } of leafPaths(data)) {
    const saved = readPath(finalParsed.value, leafPath);
    if (saved !== MISSING && leafEquals(saved, value, vars)) {
      continue;
    }
    return {
      path,
      created: false,
      changed: false,
      error: "refusing to write — duplicate keys in the target file would shadow the saved values",
    };
  }
  try {
    writeFileSync(path, running, "utf-8");
  } catch (error) {
    return { path, created: false, changed: false, error: errorMessage(error) };
  }
  return { path, created: false, changed: true };
}
