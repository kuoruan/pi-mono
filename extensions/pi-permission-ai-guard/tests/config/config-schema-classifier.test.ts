import { describe, expect, it } from "vitest";

import { configSchema, isClassifierMode } from "#src/config/config-schema.ts";

const chatBase = { provider: "anthropic", model: "claude-haiku-4-5" };
const classifierBase = { provider: { type: "typesafe" }, model: "jev-1.13" };

describe("provider union", () => {
  it("accepts a string provider (registry reference)", () => {
    expect(configSchema.safeParse(chatBase).success).toBe(true);
  });

  it("accepts a bare typesafe object (env fallback)", () => {
    const parsed = configSchema.safeParse(classifierBase);
    expect(parsed.success).toBe(true);
  });

  it("accepts a full typesafe object", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      provider: { type: "typesafe", baseUrl: "https://openrouter.ai/api", apiKey: "k" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown object type", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      provider: { type: "other" },
    });
    expect(parsed.success).toBe(false);
  });

  it("applies classifier defaults", () => {
    const parsed = configSchema.safeParse(classifierBase);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.classifier.intentThreshold).toBe(0.5);
    expect(parsed.data.classifier.riskThreshold).toBe(0.5);
    expect(parsed.data.classifier.confidenceThreshold).toBe(0.5);
    expect("timeoutMs" in parsed.data.classifier).toBe(false);
  });

  it("rejects a misspelled threshold key instead of silently defaulting", () => {
    // A stripped typo would leave the reviewer on 0.5 with no feedback, while
    // the JSON schema (additionalProperties: false) flags it in the editor.
    // The legacy alias extends the same block, so it inherits the strictness.
    expect(
      configSchema.safeParse({ ...classifierBase, classifier: { intentTreshold: 0.9 } }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...classifierBase, typesafe: { riskTreshold: 0.9 } }).success,
    ).toBe(false);
  });

  it("folds the deprecated `typesafe` thresholds, dropping its `timeoutMs`", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      typesafe: { intentThreshold: 0.9, timeoutMs: 7_000 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Thresholds still apply; `timeoutMs` is parsed for compatibility but
    // must not reach `classifier` (the primary timeout is top-level only).
    expect(parsed.data.classifier).toEqual({
      intentThreshold: 0.9,
      riskThreshold: 0.5,
      confidenceThreshold: 0.5,
    });
    expect("timeoutMs" in parsed.data.classifier).toBe(false);
    // The legacy key is folded away, so no consumer can read it.
    expect("typesafe" in parsed.data).toBe(false);
  });

  it("rejects both `classifier` and `typesafe` (never silently pick one)", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      classifier: { intentThreshold: 0.4 },
      typesafe: { intentThreshold: 0.9 },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.message.includes("deprecated"))).toBe(true);
  });
});

describe("instructions", () => {
  it("rejects a lane slot the pool never runs (no silent no-op)", () => {
    // A `classifier` slot on a chat-only pool would never apply — reject
    // loudly instead of parsing into a config that ignores the operator's
    // rules.
    const parsed = configSchema.safeParse({
      ...chatBase,
      instructions: { classifier: { background: "x" } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.path).toEqual(["instructions", "classifier"]);
    expect(parsed.error.issues[0]!.message).toContain("no classifier reviewer");
  });

  it("rejects an unknown key inside a lane slot", () => {
    // The slot objects are strict: a typo must not parse into a slot that
    // silently drops it.
    const parsed = configSchema.safeParse({
      ...chatBase,
      instructions: { chat: { rules: "x", unknown: 1 } },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a `chat` slot on a classifier-only pool", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      instructions: { chat: { rules: "x" } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.path).toEqual(["instructions", "chat"]);
  });

  it("admits a classifier slot when a classifier fallback runs", () => {
    const parsed = configSchema.safeParse({
      ...chatBase,
      fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
      instructions: { classifier: { background: "x" } },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty instructions object", () => {
    const parsed = configSchema.safeParse({ ...chatBase, instructions: {} });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.message).toContain("empty instructions");
  });

  it("rejects unknown question ids", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      instructions: { classifier: { questions: { danger_categry: "typo" } } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.path).toEqual([
      "instructions",
      "classifier",
      "questions",
      "danger_categry",
    ]);
  });

  it("rejects the retired top-level `{ background, questions }` shape", () => {
    // The old lane-implicit overlay is gone: the object arm is strict, so
    // `background` at the top level no longer parses at all.
    expect(
      configSchema.safeParse({ ...classifierBase, instructions: { background: "x" } }).success,
    ).toBe(false);
  });

  it("accepts background-only and questions-only classifier slots", () => {
    expect(
      configSchema.safeParse({
        ...classifierBase,
        instructions: { classifier: { background: "x" } },
      }).success,
    ).toBe(true);
    expect(
      configSchema.safeParse({
        ...classifierBase,
        instructions: { classifier: { questions: { risk: "x" } } },
      }).success,
    ).toBe(true);
  });

  it("rejects an empty classifier slot (a content-free slot would be a no-op)", () => {
    const parsed = configSchema.safeParse({
      ...classifierBase,
      instructions: { classifier: {} },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.message).toContain("empty classifier slot");
  });

  it("rejects a classifier slot with empty `questions`", () => {
    expect(
      configSchema.safeParse({
        ...classifierBase,
        instructions: { classifier: { questions: {} } },
      }).success,
    ).toBe(false);
  });

  it("rejects `replace` on the classifier slot (the lane is append-only)", () => {
    // The classifier's built-in background, questions, and criteria are the
    // answer contract the thresholds are calibrated against; only the chat
    // policy layer is replaceable.
    expect(
      configSchema.safeParse({
        ...classifierBase,
        instructions: { classifier: { background: "x", replace: true } },
      }).success,
    ).toBe(false);
  });

  it("accepts replace on the chat slot and defaults it to false", () => {
    expect(
      configSchema.safeParse({
        ...chatBase,
        instructions: { chat: { rules: "x", replace: true } },
      }).success,
    ).toBe(true);
    const defaulted = configSchema.safeParse({
      ...chatBase,
      instructions: { chat: { rules: "x" } },
    });
    expect(defaulted.success).toBe(true);
    if (!defaulted.success) return;
    const instructions = defaulted.data.instructions as { chat: { replace: boolean } };
    expect(instructions.chat.replace).toBe(false);
  });

  it("accepts a broadcast string in both modes", () => {
    expect(configSchema.safeParse({ ...chatBase, instructions: "rules" }).success).toBe(true);
    expect(configSchema.safeParse({ ...classifierBase, instructions: "background" }).success).toBe(
      true,
    );
  });
});

describe("modelType", () => {
  it("defaults a string provider to chat", () => {
    const parsed = configSchema.safeParse(chatBase);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.modelType).toBe("chat");
    expect(isClassifierMode(parsed.data)).toBe(false);
  });

  it("accepts a registry classifier", () => {
    const parsed = configSchema.safeParse({
      ...chatBase,
      provider: "typesafe",
      model: "jev-latest",
      modelType: "classifier",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(isClassifierMode(parsed.data)).toBe(true);
  });

  it("accepts a full overlay on a registry classifier", () => {
    const parsed = configSchema.safeParse({
      ...chatBase,
      modelType: "classifier",
      instructions: { classifier: { background: "x", questions: { risk: "y" } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects modelType on a direct connection", () => {
    const parsed = configSchema.safeParse({ ...classifierBase, modelType: "classifier" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "modelType");
    expect(issue?.message).toContain("registry (string) providers only");
  });

  it("rejects an unknown modelType", () => {
    const parsed = configSchema.safeParse({ ...classifierBase, modelType: "bogus" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // The union fails opaquely at the top; the branch error underneath is
    // the one that names the offending field and the two legal values.
    const [issue] = parsed.error.issues;
    expect(issue?.code).toBe("invalid_union");
    expect(JSON.stringify(issue)).toContain('"path":["modelType"]');
    expect(JSON.stringify(issue)).toContain('"values":["chat","classifier"]');
  });

  it("rejects modelType inside a typesafe fallback (strict)", () => {
    const parsed = configSchema.safeParse({
      ...chatBase,
      fallbacks: [
        {
          provider: { type: "typesafe", baseUrl: "https://x.ai/api", apiKey: "k" },
          model: "fb",
          modelType: "classifier",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a classifier fallback on a string provider", () => {
    const parsed = configSchema.safeParse({
      ...chatBase,
      fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
    });
    expect(parsed.success).toBe(true);
  });
});
