/**
 * Config-surface drift tests: the JSON schema (consumed by editors), the
 * zod schema (consumed by the loader), and the README's config tables
 * (consumed by operators) must agree on defaults and enum values. Three
 * hand-edited places carry this knowledge (zod, JSON schema, README table);
 * this test makes the mechanical pairs CI-enforced instead of
 * review-enforced. The example config blocks stay curated prose.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BREAKER_VERDICT_VALUES,
  CLASSIFIER_QUESTION_IDS,
  CONFIG_TOP_LEVEL_KEYS,
  IRREVERSIBLE_RULING_VALUES,
  MODEL_TYPE_VALUES,
  MODE_VALUES,
  NOTIFY_LEVEL_VALUES,
  REASONING_VALUES,
  configSchema,
  registryFallbackSchema,
} from "#src/config/config-schema.ts";
import { SUSPICION_ORDER } from "#src/config/suspicion.ts";
import { isObjectRecord } from "#src/utils.ts";

/** The schema shape this test reads: enough of draft-07 to walk it. */
interface SchemaNode {
  default?: unknown;
  description?: string;
  enum?: unknown[];
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  items?: SchemaNode;
  propertyNames?: { enum?: unknown[] };
  type?: unknown;
}

const schemaJson = JSON.parse(
  readFileSync(new URL("../../schemas/ai-guard.schema.json", import.meta.url), "utf-8"),
) as { properties: Record<string, SchemaNode> };

/**
 * Collect leaf paths and values from a materialized config object, as a
 * dotted-path → value map. The walker below is FROZEN local to this
 * test: it mirrors the module's arrays-as-leaves rule, but the module's
 * own walker is pinned by the load/persist suites, not by this copy.
 *
 * @param obj - The parsed config (defaults applied).
 * @returns A path → value map of every leaf.
 */
function flatLeafPaths(obj: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<{ path: string[]; value: unknown }> = [];
  descend(obj, [], (node, path) => entries.push({ path, value: node }));
  return Object.fromEntries(entries.map((e) => [e.path.join("."), e.value]));
}

/**
 * Leaf enumeration mirroring the module's own walker: plain objects
 * recurse, arrays are atomic leaves (the edit strategy's rule). Local to
 * this test on purpose — the walker is the comparison, not a unit under
 * test, and the module's own behaviour is pinned through
 * `loadAiGuardConfig`/`persistConfigLayer`.
 *
 * @param node - The value to walk.
 * @param path - The accumulated property path.
 * @param visit - Receives each leaf with its path.
 * @returns Nothing.
 */
function descend(
  node: unknown,
  path: string[],
  visit: (node: unknown, path: string[]) => void,
): void {
  if (isObjectRecord(node)) {
    for (const [key, value] of Object.entries(node)) descend(value, [...path, key], visit);
    return;
  }
  visit(node, path);
}

/**
 * Render a default the way the README tables spell it: compact JSON with
 * unquoted keys (`{consecutive:3,verdict:"deny"}`).
 *
 * @param value - The zod default value.
 * @returns The README spelling of that value.
 */
function renderDefault(value: unknown): string {
  return JSON.stringify(value).replaceAll(/"([A-Za-z_$][\w$]*)"(?=:)/g, "$1");
}

/**
 * Collect `| \`key\` | … | \`default\` |` rows from the README's config
 * tables, as key → default-literal pairs. Only rows whose default cell is a
 * single backticked literal claim a default; `required` and `see below`
 * cells are prose and carry no claim to check.
 *
 * @param readme - The README text.
 * @returns A key → claimed-default map.
 */
function readmeDefaults(readme: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readme.split("\n")) {
    // Unescaped pipes only: a Type cell spells union members as
    // `\"chat\"\|\"classifier\"`, and a naive split counts those as extra
    // columns — which silently dropped the five enum rows (the most
    // drift-prone ones).
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    // 3- or 4-column tables only (the config table is 4, its key tables
    // are 3). 2-column tables are prose about record fields, never
    // config defaults.
    const columns = cells.length - 2;
    if (columns !== 3 && columns !== 4) continue;
    const key = /^`([A-Za-z]\w*)`$/.exec(cells[1] ?? "")?.[1];
    const claimed = /^`([^`]+)`$/.exec(cells[columns === 4 ? 3 : 2] ?? "")?.[1];
    if (key && claimed !== undefined) out[key] = claimed;
  }
  return out;
}

/**
 * Collect path → default pairs from a JSON-schema node.
 *
 * @param node - A schema node with `properties`.
 * @param base - The path prefix for recursive calls.
 * @returns A path → default map.
 */
function jsonDefaults(node: SchemaNode, base = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const path = base ? `${base}.${key}` : key;
    if ("default" in prop) out[path] = prop.default;
    if (prop.properties) {
      Object.assign(out, jsonDefaults(prop, path));
    }
  }
  return out;
}

/**
 * Look a dotted path up in the JSON schema's properties.
 *
 * @param path - The dotted path.
 * @returns The schema node there, or undefined.
 */
function schemaNodeAt(path: string): SchemaNode | undefined {
  let node: SchemaNode | undefined = { properties: schemaJson.properties };
  for (const segment of path.split(".")) {
    // Array leaves live one `items` level down (`fallbacks[].timeoutMs`).
    node = node?.properties?.[segment] ?? node?.items?.properties?.[segment];
  }
  return node;
}

/**
 * Look a dotted path up in a parsed config.
 *
 * @param parsed - The parsed config.
 * @param path - The dotted path.
 * @returns The value there, or undefined.
 */
function atPath(parsed: unknown, path: string): unknown {
  let node: unknown = parsed;
  for (const segment of path.split(".")) {
    if (!isObjectRecord(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Build a minimal config input with one numeric leaf set.
 *
 * @param path - The dotted path of the leaf.
 * @param value - The value to set.
 * @returns The config input.
 */
function withValueAt(path: string, value: number): Record<string, unknown> {
  const root: Record<string, unknown> = { provider: "x", model: "x" };
  const segments = path.split(".");
  // The `fallbacks` leaves live inside array items; every other leaf is a
  // plain object path.
  if (segments[0] === "fallbacks") {
    const leaf = segments[segments.length - 1] as string;
    return {
      ...root,
      fallbacks: [{ provider: "x", model: "x", [leaf]: value }],
    };
  }
  const leaf = segments.pop() ?? path;
  let node = root;
  for (const segment of segments) {
    const next: Record<string, unknown> = {};
    node[segment] = next;
    node = next;
  }
  node[leaf] = value;
  return root;
}

/**
 * Collect the defaults `jsonDefaults` cannot reach: the ones inside an
 * `anyOf` branch. That walk stops at a scalar default, so a union arm's
 * own defaults (`instructions`'s slot defaults sit behind
 * `instructions: null`) are never compared by the top-level assertion.
 *
 * @param node - A schema node with `properties`.
 * @param base - The path prefix for recursive calls.
 * @returns A path → default map for every `anyOf` branch.
 */
function anyOfDefaults(node: SchemaNode, base = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const path = base ? `${base}.${key}` : key;
    for (const branch of prop.anyOf ?? []) Object.assign(out, jsonDefaults(branch, path));
    if (prop.properties) Object.assign(out, anyOfDefaults(prop, path));
  }
  return out;
}

describe("config surface drift", () => {
  it("JSON-schema defaults match the zod config", () => {
    const zodSide = flatLeafPaths(configSchema.parse({ provider: "x", model: "x" }));
    // Required fields carry no default; everything else is the default set.
    for (const key of Object.keys(zodSide)) {
      if (key === "model" || key === "provider") {
        delete zodSide[key];
      }
    }
    // Both lanes default to no backups. JSON Schema leaves the default
    // unmaterialized so conditional item types remain valid in editors.
    expect(zodSide.fallbacks).toEqual([]);
    delete zodSide.fallbacks;
    expect(zodSide).toEqual(jsonDefaults(schemaJson));
  });

  it("nested anyOf defaults agree with zod (the main walk stops short)", () => {
    // `instructions` defaults to null, so the slot defaults inside its
    // object branch are never reached by the walk above. Fill both slots
    // and require every default the JSON schema promises inside a branch
    // to come back from zod with the same value.
    const promised = anyOfDefaults(schemaJson);
    expect(Object.keys(promised).length).toBeGreaterThan(0);
    const zodSide = flatLeafPaths(
      configSchema.parse({
        provider: "x",
        model: "x",
        // Both lanes must exist or the classifier slot is rejected as a
        // no-op; only the chat slot carries a JSON-schema default.
        fallbacks: [{ provider: "y", model: "y", modelType: "classifier" }],
        instructions: { chat: { rules: "r" }, classifier: { background: "b" } },
      }),
    );
    // Projected key-by-key so a mismatch names the offending path (the
    // lint rule forbids passing an expect message).
    const actual = Object.fromEntries(Object.keys(promised).map((path) => [path, zodSide[path]]));
    expect(actual).toEqual(promised);
  });

  it("README config-table defaults match the zod defaults", () => {
    // The README is the third hand-edited copy of the defaults. Its cells
    // spell values the way `renderDefault` does; this session's docs audit
    // exists because nothing checked them.
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf-8");
    const claimed = readmeDefaults(readme);
    expect(Object.keys(claimed).length).toBeGreaterThanOrEqual(12);
    const parsed = configSchema.parse({ provider: "x", model: "x" });
    const at = (path: string): unknown => atPath(parsed, path);
    const mismatched: string[] = [];
    const unresolved: string[] = [];
    for (const [key, cell] of Object.entries(claimed)) {
      // A README key names a top-level field or one inside a top-level
      // object (`transcript.maxUserMessages`). Object-valued rows claim the
      // whole subtree default, so the lookup walks the parsed config, not
      // just its leaves.
      const paths = [key, ...Object.keys(parsed).map((parent) => `${parent}.${key}`)].filter(
        (path) => at(path) !== undefined,
      );
      const path = paths[0];
      if (path === undefined || paths.length !== 1) {
        unresolved.push(key);
        continue;
      }
      const rendered = renderDefault(at(path));
      if (rendered !== cell) mismatched.push(`${key}: README \`${cell}\` vs zod ${rendered}`);
    }
    // A row that resolves to nothing would read as agreement while checking
    // nothing: every claimed default must name exactly one zod path.
    expect(unresolved).toEqual([]);
    expect(mismatched).toEqual([]);
  });

  it("the JSON schema carries every top-level key and no extras", () => {
    // Defaults and enums were pinned; keys were not, so a new key could ship
    // in the loader and stay invisible to every editor reading this schema.
    expect(Object.keys(schemaJson.properties).toSorted()).toEqual(
      [...CONFIG_TOP_LEVEL_KEYS].toSorted(),
    );
  });

  it("the JSON schema's fallback object carries the same keys as the zod schema", () => {
    const item = schemaJson.properties.fallbacks?.items;
    expect(item?.oneOf).toBeUndefined();
    expect(Object.keys(item?.properties ?? {}).toSorted()).toEqual(
      Object.keys(registryFallbackSchema.shape).toSorted(),
    );
  });

  it("JSON-schema enums match the zod enums", () => {
    expect(schemaJson.properties.mode.enum).toEqual([...MODE_VALUES]);
    // The custom row's two cut lines range over the same ladder the zod
    // schema imports — a fourth copy of the rung list, pinned here.
    expect(schemaJson.properties.customMode.properties!.allowThrough!.enum).toEqual([
      ...SUSPICION_ORDER,
    ]);
    expect(schemaJson.properties.customMode.properties!.denyFrom!.enum).toEqual([
      ...SUSPICION_ORDER,
    ]);
    // The irreversible axis is its own three-outcome knob, not a rung on the
    // suspicion line — pinned against the same source as the zod schema.
    expect(schemaJson.properties.customMode.properties!.onIrreversibleEffect!.enum).toEqual([
      ...IRREVERSIBLE_RULING_VALUES,
    ]);
    expect(schemaJson.properties.reasoning.enum).toEqual([...REASONING_VALUES]);
    expect(schemaJson.properties.modelType.enum).toEqual([...MODEL_TYPE_VALUES]);
    expect(schemaJson.properties.notifyLevel.enum).toEqual([...NOTIFY_LEVEL_VALUES]);
    expect(
      schemaJson.properties.instructions.anyOf![1]!.properties!.classifier!.properties!.questions!
        .propertyNames!.enum,
    ).toEqual([...CLASSIFIER_QUESTION_IDS]);
    expect(schemaJson.properties.circuitBreaker.properties!.verdict.enum).toEqual([
      ...BREAKER_VERDICT_VALUES,
    ]);
  });

  it("JSON-schema numeric bounds match the zod checks", () => {
    // The hand-edited schema's bounds must equal the loader's checks: a
    // bound the editor promises but the loader rejects (or accepts but the
    // editor forbids) is a silent contract fork. Each entry is the exact
    // bound object the JSON schema carries, verified field-by-field so a
    // drift names its path.
    const bounds: Record<string, Record<string, number>> = {
      timeoutMs: { exclusiveMinimum: 0, maximum: 300000 },
      maxTokens: { minimum: 16, maximum: 32768 },
      temperature: { minimum: 0, maximum: 2 },
      "classifier.confidenceThreshold": { minimum: 0, maximum: 1 },
      "circuitBreaker.consecutive": { minimum: 1, maximum: 50 },
      "circuitBreaker.total": { minimum: 1, maximum: 200 },
      "cache.maxEntries": { minimum: 0, maximum: 1000 },
      "transcript.maxUserMessages": { minimum: 1, maximum: 50 },
      "transcript.maxToolCalls": { minimum: 1, maximum: 50 },
      "transcript.maxCharsPerEntry": { minimum: 100, maximum: 20000 },
      // Array-item leaves: the hand-edited schema bounds them separately,
      // and the loader reuses the same zod leaves for them.
      "fallbacks.timeoutMs": { exclusiveMinimum: 0, maximum: 300000 },
      "fallbacks.temperature": { minimum: 0, maximum: 2 },
    };
    for (const [path, expected] of Object.entries(bounds)) {
      const node = schemaNodeAt(path);
      const actual = Object.fromEntries(
        ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]
          .filter((key) => key in (node ?? {}))
          .map((key) => [key, (node as Record<string, unknown>)[key]]),
      );
      expect(actual).toEqual(expected);
    }

    // And the loader really enforces those numbers: every bound is accepted
    // at its stated edge and rejected one step outside it. The table is built
    // first so every assertion below is unconditional.
    const edges: Array<{ path: string; value: number; parses: boolean }> = [];
    for (const [path, declared] of Object.entries(bounds)) {
      // Integers step by one, floats by a fractional step (temperature and
      // the threshold are the only floats here).
      const step = path.endsWith("temperature") || path.endsWith("confidenceThreshold") ? 0.5 : 1;
      const minimum = declared.minimum;
      const maximum = declared.maximum;
      const exclusiveLow = declared.exclusiveMinimum;
      if (minimum !== undefined) {
        edges.push({ path, value: minimum, parses: true });
        edges.push({ path, value: minimum - step, parses: false });
      }
      if (exclusiveLow !== undefined) {
        edges.push({ path, value: exclusiveLow, parses: false });
        edges.push({ path, value: exclusiveLow + step, parses: true });
      }
      if (maximum !== undefined) {
        edges.push({ path, value: maximum, parses: true });
        edges.push({ path, value: maximum + step, parses: false });
      }
    }
    for (const { path, value, parses: expected } of edges) {
      expect(configSchema.safeParse(withValueAt(path, value)).success).toBe(expected);
    }
  });

  it("the curated mode prose carries the final wording, not the superseded one", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf-8");
    const zodSource = readFileSync(
      fileURLToPath(import.meta.resolve("#src/config/config-schema.ts")),
      "utf-8",
    );
    const modeTableSource = readFileSync(
      fileURLToPath(import.meta.resolve("#src/config/mode-table.ts")),
      "utf-8",
    );
    const description = schemaJson.properties.mode.description;
    const stale = "you decide everything";
    const canonical = "judge every flag";
    // The two operator-facing surfaces restate the rows, so each is pinned
    // separately: they drift independently unless both are checked (this
    // test exists because the mode prose once drifted this exact way).
    expect(description).toContain(canonical);
    expect(description).not.toContain(stale);
    expect(readme).toContain(canonical);
    expect(readme).not.toContain(stale);
    // The code-side twins point at the README table instead of restating
    // the rows, so there is no third copy left to drift.
    expect(zodSource).toContain("README.md");
    expect(zodSource).not.toContain(stale);
    expect(modeTableSource).not.toContain(stale);
  });
});
