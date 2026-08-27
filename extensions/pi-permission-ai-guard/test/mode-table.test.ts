/**
 * Mode-table direct tests: the ladder's single-sourced operational facts —
 * the derived cycle membership, the emphasized value, the generated cycle
 * description, and the config surprise warnings. Everything here must be
 * DERIVED from the table; a hand-placed duplicate anywhere else in the
 * codebase is a drift bug this file exists to catch.
 */

import { describe, expect, it } from "vitest";

import { MODE_VALUES } from "#src/config-schema.ts";
import {
  CYCLE_DESCRIPTION,
  CYCLE_MODE_VALUES,
  EMPHASIZED_MODE,
  MODE_TABLE,
  modeWarnings,
} from "#src/mode-table.ts";

describe("MODE_TABLE", () => {
  it("covers every mode value exactly once, in ladder order", () => {
    expect(Object.keys(MODE_TABLE)).toEqual([...MODE_VALUES]);
  });

  it("never maps machinery failures to allow in any mode", () => {
    for (const mode of MODE_VALUES) {
      expect(MODE_TABLE[mode].lanes.machinery).not.toBe("allow");
    }
  });
});

describe("derived cycle facts", () => {
  it("the casual cycle is the middle three, in ladder order", () => {
    expect(CYCLE_MODE_VALUES).toEqual(["default", "advisory", "lenient"]);
  });

  it("exactly one value renders in warning red, and it is permissive", () => {
    expect(EMPHASIZED_MODE).toBe("permissive");
    expect(MODE_VALUES.filter((m) => MODE_TABLE[m].facts.emphasize)).toEqual(["permissive"]);
  });

  it("the cycle description is generated from the cycle values", () => {
    expect(CYCLE_DESCRIPTION).toBe("default → advisory → lenient");
  });

  it("the casual cycle never includes the two extremes", () => {
    expect(CYCLE_MODE_VALUES).not.toContain("strict");
    expect(CYCLE_MODE_VALUES).not.toContain("permissive");
  });
});

describe("modeWarnings", () => {
  const base = {
    provider: "p",
    model: "m",
    reasoning: "off" as const,
    timeoutMs: 15000,
    maxTokens: 4096,
    transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
    surfaces: ["bash"],
    instructions: null,
    cache: { maxEntries: 128 },
  };

  it("warns on the two extremes combined with a breaker forced to defer", () => {
    for (const mode of ["strict", "permissive"] as const) {
      const config = {
        ...base,
        mode,
        circuitBreaker: { consecutive: 3, total: 20, verdict: "defer" as const },
      };
      const warnings = modeWarnings(config);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.path).toBe("mode");
      expect(warnings[0]!.message).toContain(`mode "${mode}"`);
      expect(warnings[0]!.message).toContain("circuitBreaker.verdict");
    }
  });

  it("stays silent otherwise", () => {
    for (const mode of MODE_VALUES) {
      const config = {
        ...base,
        mode,
        circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" as const },
      };
      expect(modeWarnings(config)).toEqual([]);
    }
    expect(
      modeWarnings({
        ...base,
        mode: "default",
        circuitBreaker: { consecutive: 3, total: 20, verdict: "defer" as const },
      }),
    ).toEqual([]);
  });
});
