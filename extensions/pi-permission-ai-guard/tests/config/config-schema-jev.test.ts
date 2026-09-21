import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";

const llmBase = { provider: "cpa", model: "lite" };
const jevBase = { provider: { type: "typesafe" }, model: "jev-1.13" };

describe("provider union", () => {
  it("accepts a string provider (registry reference)", () => {
    expect(configSchema.safeParse(llmBase).success).toBe(true);
  });

  it("accepts a bare typesafe object (env fallback)", () => {
    const parsed = configSchema.safeParse(jevBase);
    expect(parsed.success).toBe(true);
  });

  it("accepts a full typesafe object", () => {
    const parsed = configSchema.safeParse({
      ...jevBase,
      provider: { type: "typesafe", baseUrl: "https://openrouter.ai/api", apiKey: "k" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown object type", () => {
    const parsed = configSchema.safeParse({
      ...jevBase,
      provider: { type: "other" },
    });
    expect(parsed.success).toBe(false);
  });

  it("applies typesafe defaults", () => {
    const parsed = configSchema.safeParse(jevBase);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.typesafe.intentThreshold).toBe(0.5);
    expect(parsed.data.typesafe.riskThreshold).toBe(0.5);
    expect(parsed.data.typesafe.confidenceThreshold).toBe(0.5);
    expect(parsed.data.typesafe.timeoutMs).toBeUndefined();
  });
});

describe("instructions cross-field rules", () => {
  it("rejects object instructions with a string provider", () => {
    const parsed = configSchema.safeParse({
      ...llmBase,
      instructions: { background: "x" },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // Structurally impossible: the union's LLM member rejects the object
    // instructions, the Jev member rejects the string provider.
    expect(parsed.error.issues[0]!.code).toBe("invalid_union");
  });

  it("rejects an empty overlay object", () => {
    expect(configSchema.safeParse({ ...jevBase, instructions: {} }).success).toBe(false);
  });

  it("rejects unknown question ids", () => {
    const parsed = configSchema.safeParse({
      ...jevBase,
      instructions: { questions: { danger_categry: "typo" } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.path).toEqual(["instructions", "questions", "danger_categry"]);
  });

  it("accepts background-only and questions-only overlays", () => {
    expect(configSchema.safeParse({ ...jevBase, instructions: { background: "x" } }).success).toBe(
      true,
    );
    expect(
      configSchema.safeParse({ ...jevBase, instructions: { questions: { risk: "x" } } }).success,
    ).toBe(true);
  });

  it("accepts string instructions in both modes", () => {
    expect(configSchema.safeParse({ ...llmBase, instructions: "rules" }).success).toBe(true);
    expect(configSchema.safeParse({ ...jevBase, instructions: "background" }).success).toBe(true);
  });
});
