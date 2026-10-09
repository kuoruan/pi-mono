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

import {
  type AiGuardConfig,
  CLASSIFIER_ALIAS_KEY,
  EXTENSION_ID,
  configSchema,
  uncoveredInstructionLanes,
} from "./config-schema.ts";
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

/** A raw layer file: its path plus the parsed, still-unexpanded value. */
interface RawLayer {
  path: string;
  value: Record<string, unknown>;
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
  /** The file the value came from; absent unless the outcome is `loaded`. */
  sourcePath?: string;
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
  foldLegacyAlias(parsed.value, path, issues);
  return { value: parsed.value, sourcePath: path, outcome: "loaded" };
}

/**
 * Normalize a layer's classifier threshold blocks before the merge:
 *
 * - Fold the deprecated `typesafe` block into `classifier` and report it. Folding per layer (never on
 *   the merged result) keeps layer precedence intact: a project's deprecated block still beats the
 *   global layer's current key, and two layers naming the block differently merge as one field
 *   instead of colliding on the schema's both-keys rejection.
 * - Report the retired `timeoutMs` as ignored, in either block. Dropping the field itself is the
 *   schema transform's job — one place strips dead knobs.
 *
 * Both notices describe what the file says, so they are pushed while the text
 * is in hand. A layer writing both keys is left alone: that contradiction is
 * the schema's to reject, and folding either one would silently pick a winner.
 *
 * @param layer - The parsed layer value, normalized in place.
 * @param path - The layer file (for notice attribution).
 * @param issues - Issues accumulator.
 */
function foldLegacyAlias(
  layer: Record<string, unknown>,
  path: string,
  issues: ConfigIssue[],
): void {
  const alias = layer[CLASSIFIER_ALIAS_KEY];
  if (isObjectRecord(alias) && layer.classifier === undefined) {
    issues.push({
      path: CLASSIFIER_ALIAS_KEY,
      message: `\`${CLASSIFIER_ALIAS_KEY}\` is deprecated — rename it to \`classifier\``,
      sourcePath: path,
    });
    const { timeoutMs, ...thresholds } = alias;
    if (timeoutMs !== undefined) {
      issues.push({
        path: `${CLASSIFIER_ALIAS_KEY}.timeoutMs`,
        message: `\`${CLASSIFIER_ALIAS_KEY}.timeoutMs\` is ignored — set the top-level \`timeoutMs\` instead`,
        sourcePath: path,
      });
    }
    layer.classifier = thresholds;
    delete layer[CLASSIFIER_ALIAS_KEY];
  }
  const current = layer.classifier;
  if (isObjectRecord(current) && current.timeoutMs !== undefined) {
    issues.push({
      path: "classifier.timeoutMs",
      message: "`classifier.timeoutMs` is ignored — set the top-level `timeoutMs` instead",
      sourcePath: path,
    });
  }
}

/**
 * Environment-variable interpolation for config string values: `${NAME}`
 * expands to the variable's value, `${NAME:-fallback}` uses the fallback
 * when the variable is unset or empty, and `$$` escapes to a literal `$`.
 * Anything else is literal — `$NAME` (no braces), `${NAME:?…}`, and
 * command substitution are NOT supported by design. Refs do not nest either:
 * `${A:-${B}}` is read up to the first `}`, so the inner ref stays literal.
 *
 * @param value - The string value to expand.
 * @param vars - The variable source (production passes `process.env`).
 * @param onUnresolved - Called with the first unresolvable ref's name, so a
 *   caller can name the variable without echoing the value it sits in.
 * @returns The expanded string, or undefined when a referenced variable
 *   has no value and no fallback (the caller skips the layer).
 */
export function expandEnvRefs(
  value: string,
  vars: Record<string, string | undefined>,
  onUnresolved?: (name: string) => void,
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      out += "${" + expr + "}";
      continue;
    }
    // Own properties only: a prototype key (`${constructor}`, `${__proto__}`)
    // is not a variable, so an unset ref must read as unset — skip the layer
    // or take the fallback — instead of expanding the prototype member.
    const found = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (found !== undefined && found !== "") {
      out += found;
    } else if (fallback !== undefined) {
      out += done(fallback);
    } else {
      onUnresolved?.(name);
      return undefined;
    }
  }
}

// ── Leaf provenance: how a save knows what a leaf looked like on disk ──
// One concept and the predicates built on it — `readRawLayer` →
// `restorePlaceholders` → `leafEquals`, all walking with `descend`'s
// read/write split, plus the `refEquivalent` rule the last two share. Read
// them together; none is meaningful alone.

/**
 * Whether an on-disk string IS the placeholder for a snapshot value: the one
 * rule {@link leafEquals} and {@link restorePlaceholders} both decide with —
 * skip the leaf, or put the ref (never its expansion) back into the file.
 * Keeping it in one place is what stops the two from drifting apart.
 *
 * @param diskText - The string as it appears on disk (refs intact).
 * @param snapshotValue - The expanded in-memory value it must stand for.
 * @param vars - The variable source for the equivalence.
 * @returns True when expanding the disk text yields exactly that value.
 */
function refEquivalent(
  diskText: string,
  snapshotValue: unknown,
  vars: Record<string, string | undefined>,
): boolean {
  return expandEnvRefs(diskText, vars) === snapshotValue;
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
function leafEquals(
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
    (typeof previous === "string" && refEquivalent(previous, value, vars))
  );
}

/**
 * Does this subtree hold an env ref that no longer resolves? The signal that a
 * disk element's placeholder — not its value — is what a mismatched snapshot
 * entry came from, so restoring the disk text cannot drop a real edit.
 *
 * @param node - The subtree to scan.
 * @param vars - The variable source.
 * @returns True when at least one `${VAR}` no longer resolves.
 */
function hasUnresolvedRef(node: unknown, vars: Record<string, string | undefined>): boolean {
  if (typeof node === "string") {
    return node.includes("${") && expandEnvRefs(node, vars) === undefined;
  }
  if (Array.isArray(node)) return node.some((item) => hasUnresolvedRef(item, vars));
  if (isObjectRecord(node)) return Object.values(node).some((item) => hasUnresolvedRef(item, vars));
  return false;
}

/**
 * Restore `${VAR}` placeholders into an expanded snapshot subtree.
 * Persist compares the on-disk tree (placeholders intact) against the
 * in-memory snapshot (refs already expanded): without restoration a
 * changed array leaf would write back expanded secrets, destroying the
 * placeholders. Elements resolving to the snapshot value revert to the
 * on-disk text; an element whose on-disk counterpart can no longer expand
 * (env drift) is paired with that counterpart — wherever it sits — and
 * reverts to its text too: the placeholder is the operator's intent, and the
 * integrity gate refuses the write if the restoration no longer matches the
 * snapshot. Only an element with nothing to preserve keeps the snapshot
 * value.
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
    if (refEquivalent(previous, value, vars)) return previous;
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
      let hit = unused.findIndex((candidate) => leafEquals(candidate, item, vars));
      // No content match. The disk element is what the snapshot entry came
      // from when its ref no longer expands — the disk text is still what the
      // operator meant, and the snapshot value would write the expanded
      // secret over it. The match above consumed every resolvable ref, so this
      // only ever pairs with an unresolvable one; an element with nothing to
      // preserve keeps the item, so a real edit still wins.
      if (hit === -1) hit = unused.findIndex((candidate) => hasUnresolvedRef(candidate, vars));
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
    // Name the variable, never echo the leaf: a leaf can mix a literal
    // secret with a ref, and this message reaches the console and the UI.
    let unresolved: string | undefined;
    const expanded = expandEnvRefs(node, vars, (name) => {
      unresolved = name;
    });
    if (expanded === undefined) {
      ok = false;
      issues.push({
        path: path.join(".") || "$",
        message: `env ref \`\${${unresolved ?? "?"}}\` has no value and no fallback — set it or add :-`,
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
function leafPaths(value: unknown, path: string[] = []): LeafEntry[] {
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
 * Attribute a merged-config notice to the file that wrote the key: the
 * project layer wins when both did (the more specific scope), otherwise
 * whichever one carried it.
 *
 * @param key - The top-level config key the notice is about.
 * @param global - The read global layer.
 * @param project - The read project layer.
 * @returns The attributed layer file, or undefined when neither loaded.
 */
function layerThatWrote(
  key: string,
  global: LayerReadResult,
  project: LayerReadResult,
): string | undefined {
  if (project.value?.[key] !== undefined) return project.sourcePath;
  if (global.value?.[key] !== undefined) return global.sourcePath;
  return project.sourcePath ?? global.sourcePath;
}

/**
 * Whether an `instructions` value is the retired lane-implicit classifier
 * overlay: `background`/`questions` at the top level, from before the
 * per-lane slots. Detected by the shape's own keys, never by "neither slot
 * key is present" — a config that means something else must not receive a
 * migration hint that does not apply to it.
 *
 * @param value - The raw `instructions` value from the merged input.
 * @returns True when the value carries the retired top-level overlay keys.
 */
function retiredOverlayShape(value: unknown): boolean {
  return isObjectRecord(value) && ("background" in value || "questions" in value);
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
    // The retired lane-implicit overlay shape now fails as a bare
    // "unknown key". The rejection is correct; name the migration so the
    // operator learns what to write instead of guessing.
    if (retiredOverlayShape(merged.instructions)) {
      issues.push({
        path: "instructions",
        message:
          '`instructions` no longer takes top-level `background`/`questions` — wrap them in the `classifier` slot: { "classifier": { … } }',
        sourcePath: layerThatWrote("instructions", global, project),
      });
    }
    issues.push(...flattenZodIssues(parsed.error.issues));
    return { issues, outcome: "failed" };
  }

  // The notices below describe the merged shape: the deprecated alias and the
  // retired `timeoutMs` were reported while each layer was read (see
  // foldLegacyAlias), and the transform has dropped every dead field by now.
  // A canonical `instructions` object may fill only some lane slots: an
  // unlisted lane keeps the full built-in instructions. That is the
  // fail-safe direction (less customization, never a wrong one), so it is a
  // notice, not an error — but an uncovered lane must not pass silently.
  for (const lane of uncoveredInstructionLanes(parsed.data)) {
    issues.push({
      path: "instructions",
      message: `\`instructions\` has no \`${lane}\` slot — a ${lane} endpoint runs the pure built-in instructions`,
      sourcePath: layerThatWrote("instructions", global, project),
    });
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
 * - Validates the snapshot against the zod schema before any write: an invalid snapshot refuses, and
 *   only the CANONICAL parse output is written — a new file gets it whole, an edit keeps that
 *   file's own comments, key order, and unknown keys.
 * - Restores `${VAR}` text where it came from (see {@link restorePlaceholders}): a leaf whose owning
 *   layer spelled it as an env ref is written back as that ref, so a save never persists the
 *   expanded secret — least of all into a layer that never held the ref.
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
  // The sibling layer's raw file feeds both gates below and the placeholder
  // provenance each write branch restores from. It counts only when the
  // loader would read it: the global layer always, the project layer only
  // when the project is trusted.
  const siblingDir =
    target === "global" ? getProjectConfigDir(env.cwd) : getGlobalConfigDir(agentDir);
  const sibling = target === "project" || env.trustedProject ? readRawLayer(siblingDir) : undefined;
  // Edit whichever candidate exists (jsonc-first); otherwise create .jsonc
  // (resolveLayerFile stat'ed both candidates, so a resolved path exists).
  const existing = resolveLayerFile(dir);
  const siblingRaw = sibling?.value;
  if (!existing) {
    return createLayerFile(createPath, canonical.data, siblingRaw, vars);
  }
  const path = existing.path;

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return { path, created: false, changed: false, error: errorMessage(error) };
  }
  return editLayerFile(path, canonical.data, text, vars, siblingRaw);
}

/**
 * A layer's config file parsed, but NOT env-expanded: the write path needs
 * the raw `${VAR}` texts as the placeholder provenance (see
 * {@link restorePlaceholders}, and the leaf-provenance note above
 * `leafEquals`). An unreadable or malformed file reads as undefined — a
 * layer the loader skips cannot conflict with this write, so it is the
 * loader's problem, not the save's.
 *
 * @param dir - The layer's config directory.
 * @returns The file path plus its parsed object, if any.
 */
function readRawLayer(dir: string): RawLayer | undefined {
  const file = resolveLayerFile(dir);
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file.path, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = parseLayerText(text);
  return parsed.ok ? { path: file.path, value: parsed.value } : undefined;
}

/**
 * The create branch of {@link persistConfigLayer}: no file exists yet, so
 * write the snapshot whole (fresh directory included). The two branches are
 * mutually exclusive results — a file is either created from nothing or
 * edited in place — and each owns its own error surface.
 *
 * @param path - The layer file path to create.
 * @param data - The validated config snapshot to write.
 * @param sibling - The other layer's parsed raw file (placeholder source).
 * @param vars - The variable source for env-ref equivalence.
 * @returns The save result (`created: true` on success).
 */
function createLayerFile(
  path: string,
  data: AiGuardConfig,
  sibling: Record<string, unknown> | undefined,
  vars: Record<string, string | undefined>,
): SaveConfigResult {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write the operator's template, not the expanded snapshot: a leaf that
    // came from `${VAR}` text in the sibling layer goes back as that text.
    // Stringifying the snapshot verbatim would persist the expanded secret
    // into a file — an often-committed project config — that never held it.
    const template = restorePlaceholders(sibling ?? {}, data, vars);
    // No integrity gate here, unlike the edit branch: a ref the sibling holds
    // goes into the new file exactly as the operator wrote it, and the loader
    // names the missing variable on the next read — refusing to create the
    // file would leave a first-time setup with nothing to fix.
    writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
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
 * @param sibling - The other layer's parsed raw file (placeholder source).
 * @returns The save result (`changed: false` when already identical).
 */
function editLayerFile(
  path: string,
  data: AiGuardConfig,
  text: string,
  vars: Record<string, string | undefined>,
  sibling: Record<string, unknown> | undefined,
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
  // Placeholder provenance: THIS file's own raw text wins where it has the
  // leaf, else the sibling layer's — never the expanded snapshot value. A
  // leaf this file does not have yet (a new key, a whole new file) must still
  // land as the `${VAR}` text its owning layer spelled.
  const provenance = deepMerge(sibling ?? {}, parsed.value);
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
    const writeValue = restorePlaceholders(readPath(provenance, leafPath), value, vars);
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

  // The deprecated alias is folded away by the schema, so the snapshot has no
  // `typesafe` leaf and the loop above never touches it. Leaving it in place
  // would make the written file self-contradictory on the next load (both
  // keys is a schema error), so the save migrates it out.
  if (readPath(parsed.value, [CLASSIFIER_ALIAS_KEY]) !== MISSING) {
    // `modify` deletes only the FIRST matching key while the loader reads the
    // LAST, and JSONC allows the key twice. Delete until none remain: a copy
    // left behind would sit beside the `classifier` key this save writes, and
    // the final gate would refuse with a "shape conflict" nobody can act on.
    for (;;) {
      running = applyEdits(running, modify(running, [CLASSIFIER_ALIAS_KEY], undefined, {}));
      changed = true;
      const current = parseLayerText(running);
      if (!current.ok || readPath(current.value, [CLASSIFIER_ALIAS_KEY]) === MISSING) break;
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
  for (const { path: leafPath, value } of leafPaths(data)) {
    const saved = readPath(finalParsed.value, leafPath);
    if (saved !== MISSING && leafEquals(saved, value, vars)) {
      continue;
    }
    // Anything unmatched here that is a ref is ref-caused: the variable is
    // gone, or the on-disk ref resolves to something other than the snapshot
    // (the value was edited after load). Both keep the on-disk text (see
    // {@link restorePlaceholders}), so name the real conflict instead of
    // blaming shadowed keys.
    if (typeof saved === "string" && saved.includes("${")) {
      return {
        path,
        created: false,
        changed: false,
        error:
          expandEnvRefs(saved, vars) === undefined
            ? `refusing to write — ${saved} no longer resolves; set the variable (or edit the value) and save again`
            : `refusing to write — ${saved} no longer matches the saved value; edit the file's ref or the config, then save again`,
      };
    }
    // A structural leaf (arrays are written whole) mismatches the same way
    // when one of its refs no longer resolves — there is no duplicate key to
    // find, so name the drift instead of the shadowing cause below.
    if (hasUnresolvedRef(saved, vars)) {
      return {
        path,
        created: false,
        changed: false,
        error: `refusing to write — a ref at ${leafPath.join(".")} no longer resolves; set the variable (or edit the value) and save again`,
      };
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
