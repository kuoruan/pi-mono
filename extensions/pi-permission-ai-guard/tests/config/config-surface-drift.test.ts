/**
 * Config-surface drift tests: the JSON schema (consumed by editors) and
 * the zod schema (consumed by the loader) must agree on defaults and enum
 * values. Four hand-edited places carry this knowledge (zod, JSON schema,
 * README table, example config); this test makes the mechanical pair
 * CI-enforced instead of review-enforced. The README/example twins stay
 * curated prose.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BREAKER_VERDICT_VALUES,
  MODEL_TYPE_VALUES,
  MODE_VALUES,
  REASONING_VALUES,
  configSchema,
} from "#src/config/config-schema.ts";

const schemaJson = JSON.parse(
  readFileSync(new URL("../../schemas/ai-guard.schema.json", import.meta.url), "utf-8"),
) as {
  properties: Record<
    string,
    {
      default?: unknown;
      description?: string;
      enum?: unknown[];
      properties?: Record<string, { enum?: unknown[]; default?: unknown }>;
    }
  >;
};

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
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) descend(value, [...path, key], visit);
    return;
  }
  visit(node, path);
}

/**
 * Whether the value is a plain (non-array, non-null) object.
 *
 * @param value - The value to test.
 * @returns True for a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-schema node, as far as the default walk needs to see it. */
interface SchemaNode {
  default?: unknown;
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
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
  it("JSON-schema defaults match both zod config variants", () => {
    for (const provider of ["x", { type: "typesafe" }] as const) {
      const zodSide = flatLeafPaths(configSchema.parse({ provider, model: "x" }));
      // Required fields carry no default; everything else is the default set.
      for (const key of Object.keys(zodSide)) {
        if (key === "model" || key === "provider" || key.startsWith("provider.")) {
          delete zodSide[key];
        }
      }
      // Both lanes default to no backups. JSON Schema leaves the default
      // unmaterialized so conditional item types remain valid in editors.
      expect(zodSide.fallbacks).toEqual([]);
      delete zodSide.fallbacks;
      // modelType is a string-provider field: the direct variant carries
      // no default for it (the reserved optional only surfaces user input).
      const expected = jsonDefaults(schemaJson);
      if (typeof provider === "object") delete expected.modelType;
      // The deprecated `typesafe` alias exists for input compatibility
      // only: zod folds it into `classifier` and drops the key, so its
      // JSON-schema defaults must not appear in the parsed shape.
      for (const key of Object.keys(expected)) {
        if (key.startsWith("typesafe.")) delete expected[key];
      }
      expect(zodSide).toEqual(expected);
    }
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

  it("JSON-schema enums match the zod enums", () => {
    expect(schemaJson.properties.mode.enum).toEqual([...MODE_VALUES]);
    expect(schemaJson.properties.reasoning.enum).toEqual([...REASONING_VALUES]);
    expect(schemaJson.properties.modelType.enum).toEqual([...MODEL_TYPE_VALUES]);
    expect(schemaJson.properties.circuitBreaker.properties!.verdict.enum).toEqual([
      ...BREAKER_VERDICT_VALUES,
    ]);
  });

  it("the curated mode prose twins carry the final wording, not the superseded one", () => {
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
    // Short enough to sit on one line of the zod comment block (the twins
    // have different line-wrapping; only the phrase itself must not drift).
    const canonical = "judge every flag";
    // One pair per curated surface: the twins drift independently unless
    // each is pinned separately (this test exists because the mode prose
    // once drifted this exact way).
    expect(description).toContain(canonical);
    expect(description).not.toContain(stale);
    expect(zodSource).toContain(canonical);
    expect(zodSource).not.toContain(stale);
    expect(modeTableSource).toContain(canonical);
    expect(modeTableSource).not.toContain(stale);
  });
});
