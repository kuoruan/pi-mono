import { parse as parseJsonc } from "jsonc-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigEnv } from "#src/config/config-layer.ts";
import { expandEnvRefs, loadAiGuardConfig, persistConfigLayer } from "#src/config/config-layer.ts";
import type { AiGuardConfig } from "#src/config/config-schema.ts";
import { configSchema, fallbackItemSchema } from "#src/config/config-schema.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");

/**
 * A test environment: untrusted by default so the project layer stays inert.
 *
 * @param overrides - Fields to override (e.g. trustedProject: true).
 * @returns A complete ConfigEnv for load/persist calls.
 */
function env(overrides: Partial<ConfigEnv> = {}): ConfigEnv {
  return { cwd: "/project", agentDir: "/agent", trustedProject: false, ...overrides };
}

/** A full, schema-valid config the persist gate accepts. */
const fullConfig = configSchema.parse({
  provider: "anthropic",
  model: "claude-haiku-4-5",
  reasoning: "off",
  timeoutMs: 10000,
  transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
  cache: { maxEntries: 100 },
  circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" },
  surfaces: ["bash"],
  mode: "lenient",
  instructions: null,
});

describe("loadAiGuardConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("returns undefined config when no files exist", () => {
    const result = loadAiGuardConfig(env());
    expect(result.config).toBeUndefined();
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe("none");
  });

  it("loads global config", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.config).toBeDefined();
    expect(result.config?.provider).toBe("anthropic");
    expect(result.issues).toEqual([]);
    expect(result.outcome).toBe("loaded");
  });

  it("reports the deprecated `typesafe` key as an issue while still loading", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe" },
        model: "jev-1.13",
        typesafe: { intentThreshold: 0.9 },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("loaded");
    // The key still works — parsed into the current field.
    expect(result.config?.classifier.intentThreshold).toBe(0.9);
    // ...but the migration is announced, not silent.
    expect(result.issues.some((i) => i.message.includes("deprecated"))).toBe(true);
  });

  it("warns that the legacy `typesafe.timeoutMs` is ignored", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe" },
        model: "jev-1.13",
        typesafe: { timeoutMs: 7_000 },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("loaded");
    // Accepted (no parse failure) but called out — it no longer feeds the
    // primary timeout, which is top-level only.
    expect(result.issues.some((i) => i.message.includes("typesafe.timeoutMs"))).toBe(true);
  });

  it("names the unresolved variable without echoing the value it sits in", () => {
    // A leaf can mix a literal secret with a ref, and this message reaches the
    // console and the UI — so it names the variable, never the leaf.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: {
          type: "typesafe",
          apiKey: "sk-ant-${MISSING}-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        },
        model: "jev-1.13",
      }),
    });

    const result = loadAiGuardConfig(env(), {});
    expect(result.outcome).toBe("failed");
    const issue = result.issues.find((i) => i.message.includes("no value and no fallback"));
    expect(issue?.message).toContain("${MISSING}");
    expect(issue?.message).not.toContain("sk-ant-");
  });

  it("warns when canonical instructions leave a pool lane on the built-ins", () => {
    // A mixed pool (chat primary + classifier fallback) with only a
    // classifier slot: chat keeps pure built-ins. Fail-safe direction, but
    // never silent.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
        instructions: { classifier: { background: "project rules" } },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("loaded");
    const notice = result.issues.find((i) => i.path === "instructions");
    expect(notice?.message).toContain("no `chat` slot");
    expect(notice?.message).toContain("built-in instructions");
  });

  it("warns in the mirrored direction (classifier primary, chat fallback)", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe" },
        model: "jev-1.13",
        fallbacks: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
        instructions: { classifier: { background: "project rules" } },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("loaded");
    const notice = result.issues.find((i) => i.path === "instructions");
    expect(notice?.message).toContain("no `chat` slot");
  });

  it("names the migration for the retired top-level overlay shape", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe" },
        model: "jev-1.13",
        instructions: { background: "project rules" },
      }),
    });

    const result = loadAiGuardConfig(env());
    // Still a failure — the shape is gone, not deprecated — but the
    // message says what to write instead of only "unknown key".
    expect(result.outcome).toBe("failed");
    expect(
      result.issues.some((i) => i.message.includes("wrap them in the `classifier` slot")),
    ).toBe(true);
  });

  it("reports each layer's deprecated key against the file that wrote it", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        typesafe: { intentThreshold: 0.9 },
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        typesafe: { riskThreshold: 0.8 },
      }),
    });

    const result = loadAiGuardConfig(env({ trustedProject: true }));
    expect(result.outcome).toBe("loaded");
    // The fold is per layer, so each notice names the file it came from —
    // no merged-value guesswork.
    const notices = result.issues.filter((i) => i.path === "typesafe");
    expect(notices.map((i) => i.sourcePath)).toEqual([
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "/project/.pi/extensions/pi-permission-ai-guard/config.json",
    ]);
  });

  it("merges a deprecated project block with a current global block per field", () => {
    // The two layers name the same block differently. Folding per layer lets
    // the project's deprecated thresholds reach the merge intact, instead of
    // the merged result carrying two keys at once.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        classifier: { intentThreshold: 0.2 },
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        typesafe: { intentThreshold: 0.9 },
      }),
    });

    const result = loadAiGuardConfig(env({ trustedProject: true }));
    expect(result.outcome).toBe("loaded");
    expect(result.config?.classifier).toEqual({
      intentThreshold: 0.9,
      riskThreshold: 0.5,
      confidenceThreshold: 0.5,
    });
  });

  it("rejects a single layer writing both `typesafe` and `classifier`", () => {
    // No fold inside one file can pick a winner for the operator, so the
    // schema's contradiction rejection still applies.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        classifier: { intentThreshold: 0.2 },
        typesafe: { intentThreshold: 0.9 },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("failed");
    expect(result.issues.some((i) => i.message.includes("keep only `classifier`"))).toBe(true);
  });

  it("accepts the retired `classifier.timeoutMs` and reports it as ignored", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        classifier: { intentThreshold: 0.7, timeoutMs: 7_000 },
      }),
    });

    const result = loadAiGuardConfig(env());
    // Parsed for compatibility, never load-bearing: the primary timeout is
    // the top-level `timeoutMs` on both lanes.
    expect(result.outcome).toBe("loaded");
    expect(result.config?.classifier.intentThreshold).toBe(0.7);
    expect(result.config && "timeoutMs" in result.config.classifier).toBe(false);
    expect(result.issues.some((i) => i.message.includes("classifier.timeoutMs"))).toBe(true);
  });

  it("stays quiet on instructions coverage when both pool lanes have a slot", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
        instructions: {
          chat: { rules: "chat rules" },
          classifier: { background: "classifier background" },
        },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("loaded");
    expect(result.issues.filter((i) => i.path === "instructions")).toEqual([]);
  });

  it("stays quiet on the broadcast string form", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
        instructions: "shared rules",
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.outcome).toBe("loaded");
    expect(result.issues.filter((i) => i.path === "instructions")).toEqual([]);
  });

  it("stays quiet on the deprecation issue once the key is renamed", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe" },
        model: "jev-1.13",
        classifier: { intentThreshold: 0.9 },
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.issues).toEqual([]);
    expect(result.config?.classifier.intentThreshold).toBe(0.9);
  });

  it("loads project config overriding global", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "global-model",
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        model: "project-model",
      }),
    });

    const result = loadAiGuardConfig(env({ trustedProject: true }));
    expect(result.config?.provider).toBe("anthropic"); // from global
    expect(result.config?.model).toBe("project-model"); // overridden by project
  });

  it("records issue on malformed JSON", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": "{ invalid json",
    });

    const result = loadAiGuardConfig(env());
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]!.message).toContain("Failed to read");
  });

  it("records issue on non-object JSON", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": "[]",
    });

    const result = loadAiGuardConfig(env());
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]!.message).toContain("Expected a JSON object");
  });

  it("records issue on invalid config values", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
      }), // missing model
    });

    const result = loadAiGuardConfig(env());
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.outcome).toBe("failed");
  });

  it("skips project config when trustedProject is false", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "global-model",
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        model: "project-model",
      }),
    });

    // Untrusted: project layer must be ignored, so global model wins.
    const result = loadAiGuardConfig(env({ trustedProject: false }));
    expect(result.config?.model).toBe("global-model");
  });

  it("names the skipped project config when untrusted and no global config exists", () => {
    vol.fromJSON({
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "project-model",
      }),
    });

    // No global layer: the skip is the ONLY issue, so the fail-safe start
    // can name it instead of claiming no config file exists.
    const result = loadAiGuardConfig(env({ trustedProject: false }));
    expect(result.config).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain("untrusted");
    expect(result.issues[0]!.sourcePath).toContain("config.json");
    // The fail-safe start switches on this: a skipped-but-present file is
    // "config not applied", never "no config found".
    expect(result.outcome).toBe("failed");
  });

  it("expands env refs in string leaves", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe", baseUrl: "https://x.ai/api", apiKey: "${TEST_AI_GUARD_KEY}" },
        model: "m",
      }),
    });

    const result = loadAiGuardConfig(env(), { TEST_AI_GUARD_KEY: "live-key" });
    expect(result.config).toBeDefined();
    expect(result.issues).toEqual([]);
    // The leaf value is what proves the expansion ran: an unexpanded `${…}`
    // still satisfies the schema and leaves the issue list empty.
    const provider = result.config?.provider;
    expect(typeof provider === "object" ? provider.apiKey : undefined).toBe("live-key");
  });

  it("expands env refs inside arrays (fallbacks lane)", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "m",
        fallbacks: [
          {
            provider: {
              type: "typesafe",
              baseUrl: "https://x.ai/api",
              apiKey: "${TEST_AI_GUARD_KEY}",
            },
            model: "fb",
          },
        ],
      }),
    });

    const result = loadAiGuardConfig(env(), { TEST_AI_GUARD_KEY: "live-key" });
    expect(result.config).toBeDefined();
    expect(result.issues).toEqual([]);
    // The nested array leaf is the point: a top-level-only walk would leave
    // this placeholder and still pass the two assertions above.
    const fallback = result.config?.fallbacks?.[0];
    const provider = fallback?.provider;
    expect(typeof provider === "object" ? provider.apiKey : undefined).toBe("live-key");
  });

  it("uses the :- fallback when the variable is missing, and skips the layer otherwise", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "${TEST_AI_GUARD_MISSING:-fallback-model}",
      }),
    });
    expect(loadAiGuardConfig(env(), {}).config?.model).toBe("fallback-model");

    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "${TEST_AI_GUARD_MISSING}",
      }),
    });
    const result = loadAiGuardConfig(env(), {});
    expect(result.config).toBeUndefined();
    expect(result.issues[0]?.path).toBe("model");
    expect(result.issues[0]?.message).toContain("TEST_AI_GUARD_MISSING");
  });

  it("keeps the disk placeholder when the snapshot carries the expanded value", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe", baseUrl: "https://x.ai/api", apiKey: "${TEST_AI_GUARD_KEY}" },
        model: "m",
      }),
    });
    const loaded = loadAiGuardConfig(env(), { TEST_AI_GUARD_KEY: "live-key" });
    expect(loaded.config).toBeDefined();

    const saved = persistConfigLayer({
      target: "global",
      env: env(),
      config: loaded.config!,
      vars: { TEST_AI_GUARD_KEY: "live-key" },
    });
    expect(saved.error).toBeUndefined();
    // Other leaves (schema defaults missing from the file) still write —
    // what matters is the placeholder survives, not a zero diff.
    const disk = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    expect(disk).toContain("${TEST_AI_GUARD_KEY}");
    expect(disk).not.toContain("live-key");
  });

  it("keeps array placeholders when another leaf changes", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "m",
        fallbacks: [
          {
            provider: {
              type: "typesafe",
              baseUrl: "https://x.ai/api",
              apiKey: "${TEST_AI_GUARD_FB_KEY}",
            },
            model: "fb",
          },
        ],
      }),
    });
    const loaded = loadAiGuardConfig(env(), { TEST_AI_GUARD_FB_KEY: "live-fb-key" });
    expect(loaded.config).toBeDefined();

    // Change an unrelated leaf so the persist path must write — the
    // expanded array leaf must keep its on-disk placeholder text.
    const saved = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...loaded.config!, model: "m2" },
      vars: { TEST_AI_GUARD_FB_KEY: "live-fb-key" },
    });
    expect(saved.error).toBeUndefined();
    expect(saved.changed).toBe(true);
    const disk = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    expect(disk).toContain("${TEST_AI_GUARD_FB_KEY}");
    expect(disk).not.toContain("live-fb-key");
  });

  it("keeps array placeholders when a snapshot entry is prepended", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "m",
        fallbacks: [
          {
            provider: {
              type: "typesafe",
              baseUrl: "https://x.ai/api",
              apiKey: "${TEST_AI_GUARD_FB_KEY}",
            },
            model: "fb",
          },
        ],
      }),
    });
    const loaded = loadAiGuardConfig(env(), { TEST_AI_GUARD_FB_KEY: "live-fb-key" });
    expect(loaded.config).toBeDefined();

    // Prepending shifts every position: content matching (not positional)
    // must still find the pre-existing entry's placeholder.
    const loadedConfig = loaded.config!;
    const prepended: typeof loadedConfig = {
      ...loadedConfig,
      fallbacks: [
        fallbackItemSchema.parse({
          provider: { type: "typesafe", baseUrl: "https://y.ai/api", apiKey: "plain-key" },
          model: "fb2",
        }),
        ...loadedConfig.fallbacks,
      ],
    };
    const saved = persistConfigLayer({
      target: "global",
      env: env(),
      config: prepended,
      vars: { TEST_AI_GUARD_FB_KEY: "live-fb-key" },
    });
    expect(saved.error).toBeUndefined();
    expect(saved.changed).toBe(true);
    const disk = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    expect(disk).toContain("${TEST_AI_GUARD_FB_KEY}");
    expect(disk).not.toContain("live-fb-key");
  });

  it("keeps array placeholders when a snapshot entry is appended", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "m",
        fallbacks: [
          {
            provider: {
              type: "typesafe",
              baseUrl: "https://x.ai/api",
              apiKey: "${TEST_AI_GUARD_FB_KEY}",
            },
            model: "fb",
          },
        ],
      }),
    });
    const loaded = loadAiGuardConfig(env(), { TEST_AI_GUARD_FB_KEY: "live-fb-key" });
    expect(loaded.config).toBeDefined();

    // Appending a fallback changes the array shape: the new entry writes
    // expanded, but the pre-existing entry keeps its placeholder.
    const loadedConfig = loaded.config!;
    const appended: typeof loadedConfig = {
      ...loadedConfig,
      fallbacks: [
        ...loadedConfig.fallbacks,
        fallbackItemSchema.parse({
          provider: { type: "typesafe", baseUrl: "https://y.ai/api", apiKey: "plain-key" },
          model: "fb2",
        }),
      ],
    };
    const saved = persistConfigLayer({
      target: "global",
      env: env(),
      config: appended,
      vars: { TEST_AI_GUARD_FB_KEY: "live-fb-key" },
    });
    expect(saved.error).toBeUndefined();
    expect(saved.changed).toBe(true);
    const disk = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    expect(disk).toContain("${TEST_AI_GUARD_FB_KEY}");
    expect(disk).not.toContain("live-fb-key");
  });

  describe("expandEnvRefs", () => {
    const vars = { A: "a", EMPTY: "" };
    it.each([
      ["plain", "plain"],
      ["${A}", "a"],
      ["Bearer ${A}", "Bearer a"],
      ["${MISSING:-fb}", "fb"],
      ["${EMPTY:-fb}", "fb"],
      ["$${A}", "${A}"],
      ["$A", "$A"],
      ["${1BAD}", "${1BAD}"],
      ["${UNCLOSED", "${UNCLOSED"],
    ])("%s expands to %s", (input, expected) => {
      expect(expandEnvRefs(input, vars)).toBe(expected);
    });
    it("returns undefined for a missing variable without fallback", () => {
      expect(expandEnvRefs("${MISSING}", vars)).toBeUndefined();
    });
  });

  it("honors project config when trustedProject is true", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "global-model",
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        model: "project-model",
      }),
    });

    const result = loadAiGuardConfig(env({ trustedProject: true }));
    expect(result.config?.model).toBe("project-model");
  });

  it("deep merges nested objects so project overrides a single field without losing siblings", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "haiku",
        transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        transcript: { maxUserMessages: 3 },
      }),
    });

    const result = loadAiGuardConfig(env({ trustedProject: true }));
    expect(result.config?.transcript.maxUserMessages).toBe(3); // project override
    expect(result.config?.transcript.maxToolCalls).toBe(10); // preserved from global
    expect(result.config?.transcript.maxCharsPerEntry).toBe(1000); // preserved from global
  });
});

describe("loadAiGuardConfig — mode", () => {
  beforeEach(() => {
    vol.reset();
  });

  it('defaults mode to "default"', () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.config?.mode).toBe("default");
    expect(result.issues).toEqual([]);
  });

  it("rejects an invalid mode value", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        mode: "yolo",
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.config).toBeUndefined();
    expect(result.issues.some((i) => i.path === "mode")).toBe(true);
  });

  it("warns on the permissive + breaker-defer combination (legal but interrupts)", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        mode: "permissive",
        circuitBreaker: { verdict: "defer" },
      }),
    });

    const result = loadAiGuardConfig(env());
    // The config itself is valid — the escape valve is a designed feature.
    expect(result.config?.mode).toBe("permissive");
    expect(result.config?.circuitBreaker.verdict).toBe("defer");
    const warning = result.issues.find((i) => i.path === "mode");
    expect(warning?.message).toContain("circuitBreaker.verdict");
  });

  it("does not warn on strict with the default breaker deny", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        mode: "strict",
      }),
    });

    const result = loadAiGuardConfig(env());
    expect(result.issues).toEqual([]);
  });

  it("warns on the strict + breaker-defer combination too", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        mode: "strict",
        circuitBreaker: { verdict: "defer" },
      }),
    });

    const result = loadAiGuardConfig(env());
    const warning = result.issues.find((i) => i.path === "mode");
    expect(warning?.message).toContain("circuitBreaker.verdict");
    expect(warning?.message).toContain('"strict"');
  });
});

describe("config loader — JSONC", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("loads config with comments and trailing commas", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": `{
  // the reviewer model
  "provider": "anthropic",
  "model": "claude-haiku-4-5", // cheap + fast
  "mode": "lenient",
}
`,
    });
    const result = loadAiGuardConfig(env());
    expect(result.config?.mode).toBe("lenient");
    expect(result.issues).toEqual([]);
  });

  it("still records an issue on genuinely malformed JSONC", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": "{ invalid json",
    });
    const result = loadAiGuardConfig(env());
    expect(result.config).toBeUndefined();
    expect(result.issues[0]?.message).toContain("Failed to read");
  });
});

describe("persistConfigLayer", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("saves the full snapshot to the global layer when the file is missing", () => {
    const result = persistConfigLayer({ target: "global", env: env(), config: fullConfig });
    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.path).toBe("/agent/extensions/pi-permission-ai-guard/config.jsonc");
    const written = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.jsonc",
      "utf-8",
    ) as string;
    expect(JSON.parse(written)).toEqual(fullConfig);
  });

  it("saves to the project layer (cwd path)", () => {
    const result = persistConfigLayer({
      target: "project",
      env: env({ trustedProject: true }),
      config: fullConfig,
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe("/project/.pi/extensions/pi-permission-ai-guard/config.jsonc");
    expect(
      JSON.parse(
        vol.readFileSync(
          "/project/.pi/extensions/pi-permission-ai-guard/config.jsonc",
          "utf-8",
        ) as string,
      ),
    ).toEqual(fullConfig);
  });

  it("refuses the project target for an untrusted project — before any filesystem work", () => {
    const result = persistConfigLayer({
      target: "project",
      env: env({ trustedProject: false }),
      config: fullConfig,
    });
    expect(result.error).toContain("untrusted");
    expect(result.path).toBe("");
    expect(result.created).toBe(false);
    expect(result.changed).toBe(false);
    expect(vol.existsSync("/project/.pi/extensions/pi-permission-ai-guard/config.jsonc")).toBe(
      false,
    );
  });

  it("edits only the changed leaves — comments and formatting survive", () => {
    const original = `{
  // careful with models
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "mode": "lenient",
  "circuitBreaker": { "consecutive": 3 }
}
`;
    vol.fromJSON({ "/agent/extensions/pi-permission-ai-guard/config.json": original });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, mode: "strict" },
    });
    expect(result.changed).toBe(true);
    expect(result.created).toBe(false);
    const written = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    // The comment and the untouched fields survive byte-for-byte; the
    // changed leaf and the appended missing leaves land too.
    expect(written).toContain("// careful with models");
    expect(written).toContain('"mode": "strict"');
    // The file is JSONC — parse back through the same tolerant parser.
    expect(parseJsonc(written)).toEqual({ ...fullConfig, mode: "strict" });
  });

  it("appends missing leaves without touching the rest", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": `{
  "provider": "anthropic"
}
`,
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: configSchema.parse({ ...fullConfig, provider: "anthropic", mode: "lenient" }),
    });
    expect(result.changed).toBe(true);
    const written = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    expect(written).toContain('"provider": "anthropic"');
    expect(JSON.parse(written)).toEqual(
      configSchema.parse({ ...fullConfig, provider: "anthropic", mode: "lenient" }),
    );
  });

  it("reports changed: false and writes nothing when the layer already matches", () => {
    const text = JSON.stringify(fullConfig, null, 2);
    vol.fromJSON({ "/agent/extensions/pi-permission-ai-guard/config.json": text });
    const before = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    );
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: fullConfig,
    });
    expect(result.changed).toBe(false);
    expect(vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8")).toBe(
      before,
    );
  });

  it("refuses invalid JSONC untouched", () => {
    vol.fromJSON({ "/agent/extensions/pi-permission-ai-guard/config.json": "{ invalid json" });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, mode: "strict" },
    });
    expect(result.error).toContain("not valid JSONC");
    expect(vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8")).toBe(
      "{ invalid json",
    );
  });

  it("refuses a non-object root untouched", () => {
    vol.fromJSON({ "/agent/extensions/pi-permission-ai-guard/config.json": "[]" });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, mode: "strict" },
    });
    expect(result.error).toContain("not a JSON object");
  });

  it("reports errors with the REAL file name — not a hardcoded config.json", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.jsonc": "{ oops",
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: fullConfig,
    });
    expect(result.error).toContain("config.jsonc is not valid JSONC");
    expect(result.error).not.toContain("config.json is not valid");
  });

  it("refuses duplicate-key files that would shadow the saved value — no false success", () => {
    // jsonc-parser edits the FIRST occurrence; parse/readPath see the LAST.
    // A "successful" save here would still read back "manual" next load.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json":
        '{ "provider": "anthropic", "model": "claude-haiku-4-5", "mode": "strict", "mode": "lenient" }',
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, mode: "default" },
    });
    expect(result.error).toContain("duplicate keys");
    expect(result.changed).toBe(false);
    expect(vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8")).toBe(
      '{ "provider": "anthropic", "model": "claude-haiku-4-5", "mode": "strict", "mode": "lenient" }',
    );
  });

  it("refuses a structural conflict in the target file — no false success", () => {
    // Syntax-legal but schema-invalid: transcript is a scalar where the
    // config expects an object. jsonc-parser's setProperty silently skips
    // such edits, so the final-integrity gate must refuse, not "save".
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": `{
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "transcript": 5
}
`,
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, transcript: { ...fullConfig.transcript, maxUserMessages: 3 } },
    });
    expect(result.error).toBeDefined();
    expect(result.changed).toBe(false);
    expect(vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8")).toBe(
      `{
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "transcript": 5
}
`,
    );
  });

  it("replaces an ARRAY leaf wholesale while the rest keeps its formatting", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": `{
  "provider": "anthropic",
  // surfaces reviewed by the link
  "surfaces": ["bash"],
  "model": "claude-haiku-4-5"
}
`,
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, surfaces: ["mcp"] },
    });
    expect(result.changed).toBe(true);
    const written = vol.readFileSync(
      "/agent/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    // jsonc-parser formats a replaced array multi-line; the comment and
    // the value are what matter.
    expect(written).toContain("// surfaces reviewed by the link");
    expect(written).toContain('"mcp"');
    expect(parseJsonc(written).surfaces).toEqual(["mcp"]);
  });

  it("inserts the full snapshot into an empty-object file", () => {
    vol.fromJSON({ "/agent/extensions/pi-permission-ai-guard/config.json": "{}" });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: fullConfig,
    });
    expect(result.changed).toBe(true);
    expect(
      parseJsonc(
        vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8") as string,
      ),
    ).toEqual(fullConfig);
  });

  it("refuses an invalid snapshot (schema gate) without touching the file", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify(fullConfig),
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      // A bad override value — legal to TYPE-check past SaveConfigFn is
      // impossible, so this simulates a hand-injected invalid snapshot.
      config: { ...fullConfig, mode: "yolo" } as unknown as AiGuardConfig,
    });
    expect(result.error).toContain("snapshot is invalid");
    expect(vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8")).toBe(
      JSON.stringify(fullConfig),
    );
  });

  it("writes the CANONICAL parse output — unknown keys are stripped, not persisted", () => {
    const withJunk = { ...fullConfig, junk: "not a config field" };
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: withJunk as unknown as AiGuardConfig,
    });
    expect(result.created).toBe(true);
    const written = JSON.parse(
      vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.jsonc", "utf-8") as string,
    );
    expect(written).toEqual(fullConfig);
    expect("junk" in written).toBe(false);
  });

  it("saves into the project layer while the global alias stays put", () => {
    // The loader folds each layer's alias before merging, so a save that
    // writes `classifier` into one layer cannot break a config whose other
    // layer still spells that block `typesafe`.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        typesafe: { intentThreshold: 0.6 },
      }),
    });
    const result = persistConfigLayer({
      target: "project",
      env: env({ trustedProject: true }),
      config: fullConfig,
    });
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(true);
    // The other layer is untouched — migrating it is the operator's call.
    expect(
      vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8") as string,
    ).toContain("typesafe");
  });

  it("ignores a `typesafe` alias in an untrusted project layer (it isn't honored)", () => {
    // The loader skips the project layer entirely when the project isn't
    // trusted, so its alias is not part of the config a global save matches.
    vol.fromJSON({
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "typesafe",
        model: "jev-latest",
        typesafe: { intentThreshold: 0.6 },
      }),
    });
    const result = persistConfigLayer({
      target: "global",
      env: env({ trustedProject: false }),
      config: fullConfig,
    });
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(true);
  });

  it("reads an unparsable sibling layer as absent (the save proceeds)", () => {
    // A sibling the loader could not read cannot conflict with this write, so
    // a corrupted one must not block the save.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": "{ not json",
    });
    const result = persistConfigLayer({
      target: "project",
      env: env({ trustedProject: true }),
      config: fullConfig,
    });
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(true);
  });

  it("migrates the deprecated `typesafe` key out of the file on save", () => {
    // A file still carrying the alias cannot stay as it is: the snapshot has
    // only `classifier` (the schema folds the alias away), so writing the
    // snapshot back would leave BOTH keys — a contradiction the loader
    // rejects, which used to make every save of a legacy config fail.
    const legacy = {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      typesafe: { intentThreshold: 0.6, riskThreshold: 0.5, confidenceThreshold: 0.5 },
    };
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify(legacy),
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: configSchema.parse(legacy),
    });
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    const written = parseJsonc(
      vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8") as string,
    );
    expect("typesafe" in written).toBe(false);
    // The alias's thresholds were folded, not dropped.
    expect(written.classifier).toEqual({
      intentThreshold: 0.6,
      riskThreshold: 0.5,
      confidenceThreshold: 0.5,
    });
  });

  it("writes the sibling layer's `${VAR}` text into a newly created file", () => {
    // The snapshot holds the expanded secret. Stringifying it into a brand-new
    // file would persist the secret into a layer that only ever held the ref —
    // often a committed project config.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe", apiKey: "${MY_KEY}" },
        model: "jev-1.13",
      }),
    });
    const result = persistConfigLayer({
      target: "project",
      env: env({ trustedProject: true }),
      config: configSchema.parse({
        provider: { type: "typesafe", apiKey: "sk-real" },
        model: "jev-1.13",
      }),
      vars: { MY_KEY: "sk-real" },
    });
    expect(result.error).toBeUndefined();
    const written = vol.readFileSync(
      "/project/.pi/extensions/pi-permission-ai-guard/config.jsonc",
      "utf-8",
    ) as string;
    expect(written).toContain("${MY_KEY}");
    expect(written).not.toContain("sk-real");
  });

  it("refuses a save whose on-disk ref no longer resolves, and names it", () => {
    // The load resolved `${MY_KEY}`; by save time the variable is gone. The
    // ref stays on disk instead of being replaced by a value the config could
    // no longer produce — and the message says which ref is stuck.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe", apiKey: "${MY_KEY}" },
        model: "jev-1.13",
      }),
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: configSchema.parse({
        provider: { type: "typesafe", apiKey: "sk-real" },
        model: "jev-1.13",
      }),
      vars: {},
    });
    expect(result.changed).toBe(false);
    expect(result.error).toContain("${MY_KEY}");
    expect(result.error).toContain("no longer resolves");
  });

  it("refuses a save when the on-disk ref resolves to a different value", () => {
    // The ref still resolves, but not to the snapshot's value — the value was
    // edited after the load. Writing the snapshot would drop the operator's
    // placeholder, so the save stops and says which conflict it hit.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe", apiKey: "${MY_KEY}" },
        model: "jev-1.13",
      }),
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: configSchema.parse({
        provider: { type: "typesafe", apiKey: "sk-new" },
        model: "jev-1.13",
      }),
      vars: { MY_KEY: "sk-real" },
    });
    expect(result.changed).toBe(false);
    expect(result.error).toContain("no longer matches");
    expect(
      vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8") as string,
    ).toContain("${MY_KEY}");
  });

  it("restores the placeholder for a leaf the target file does not have yet", () => {
    // The edit branch only rewrites changed leaves, but a leaf the target file
    // lacks still has to land as the ref its owning layer spelled.
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe", apiKey: "${MY_KEY}" },
        model: "jev-1.13",
      }),
      "/project/.pi/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: { type: "typesafe" },
        model: "jev-1.13",
      }),
    });
    const result = persistConfigLayer({
      target: "project",
      env: env({ trustedProject: true }),
      config: configSchema.parse({
        provider: { type: "typesafe", apiKey: "sk-real" },
        model: "jev-1.13",
      }),
      vars: { MY_KEY: "sk-real" },
    });
    expect(result.error).toBeUndefined();
    expect(result.changed).toBe(true);
    const written = vol.readFileSync(
      "/project/.pi/extensions/pi-permission-ai-guard/config.json",
      "utf-8",
    ) as string;
    expect(written).toContain("${MY_KEY}");
    expect(written).not.toContain("sk-real");
  });
});

describe("config file discovery — jsonc preferred", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("prefers config.jsonc when both files exist (with an ambiguity warning)", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "json-model",
      }),
      "/agent/extensions/pi-permission-ai-guard/config.jsonc": JSON.stringify({
        // the jsonc file wins
        provider: "openai",
        model: "jsonc-model",
      }),
    });
    const result = loadAiGuardConfig(env());
    expect(result.config?.model).toBe("jsonc-model");
    expect(
      result.issues.some((i) => i.message.includes("Both config.jsonc and config.json exist")),
    ).toBe(true);
  });

  it("loads a lone config.jsonc", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.jsonc": `{
  // comment ok
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
}
`,
    });
    const result = loadAiGuardConfig(env());
    expect(result.config?.provider).toBe("anthropic");
    expect(result.issues).toEqual([]);
  });

  it("still loads a lone config.json (legacy)", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "legacy-model",
      }),
    });
    const result = loadAiGuardConfig(env());
    expect(result.config?.model).toBe("legacy-model");
    expect(result.issues).toEqual([]);
  });

  it("persist edits the jsonc file when both exist", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({ mode: "strict" }),
      "/agent/extensions/pi-permission-ai-guard/config.jsonc": `{
  "mode": "strict"
}
`,
    });
    const result = persistConfigLayer({
      target: "global",
      env: env(),
      config: { ...fullConfig, mode: "lenient" },
    });
    expect(result.path).toBe("/agent/extensions/pi-permission-ai-guard/config.jsonc");
    expect(result.changed).toBe(true);
    expect(
      vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.jsonc", "utf-8"),
    ).toContain('"mode": "lenient"');
    // the legacy json is untouched
    expect(
      JSON.parse(
        vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.json", "utf-8") as string,
      ),
    ).toEqual({ mode: "strict" });
  });
});
