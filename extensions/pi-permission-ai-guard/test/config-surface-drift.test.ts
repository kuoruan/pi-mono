/**
 * Config-surface drift tests: the JSON schema (consumed by editors) and
 * the zod schema (consumed by the loader) must agree on defaults and enum
 * values. Four hand-edited places carry this knowledge (zod, JSON schema,
 * README table, example config); this test makes the mechanical pair
 * CI-enforced instead of review-enforced. The README/example twins stay
 * curated prose.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BREAKER_VERDICT_VALUES,
  MODE_VALUES,
  REASONING_VALUES,
  configSchema,
} from "#src/config-schema.ts";

const schemaJson = JSON.parse(
  readFileSync(new URL("../schemas/ai-guard.schema.json", import.meta.url), "utf-8"),
) as {
  properties: Record<
    string,
    { default?: unknown; enum?: unknown[]; properties?: Record<string, { enum?: unknown[] }> }
  >;
};

/**
 * Collect leaf paths and values from a materialized config object.
 *
 * @param obj - The parsed config (defaults applied).
 * @param base - The path prefix for recursive calls.
 * @returns A path → value map of every leaf.
 */
function leafPaths(obj: Record<string, unknown>, base = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = base ? `${base}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, leafPaths(value as Record<string, unknown>, path));
    } else {
      out[path] = value;
    }
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
function jsonDefaults(
  node: { properties?: Record<string, { default?: unknown; properties?: unknown }> },
  base = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const path = base ? `${base}.${key}` : key;
    if ("default" in prop) out[path] = prop.default;
    if (prop.properties) {
      Object.assign(out, jsonDefaults(prop as never, path));
    }
  }
  return out;
}

describe("config surface drift", () => {
  it("JSON-schema defaults match the zod schema's materialized defaults", () => {
    const zodSide = leafPaths(configSchema.parse({ provider: "x", model: "x" }));
    // Required fields carry no default; everything else is the default set.
    delete zodSide.provider;
    delete zodSide.model;
    expect(zodSide).toEqual(jsonDefaults(schemaJson));
  });

  it("JSON-schema enums match the zod enums", () => {
    expect(schemaJson.properties.mode.enum).toEqual([...MODE_VALUES]);
    expect(schemaJson.properties.reasoning.enum).toEqual([...REASONING_VALUES]);
    expect(schemaJson.properties.circuitBreaker.properties!.verdict.enum).toEqual([
      ...BREAKER_VERDICT_VALUES,
    ]);
  });
});
