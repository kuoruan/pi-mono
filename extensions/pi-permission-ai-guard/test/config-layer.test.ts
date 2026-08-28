import { parse as parseJsonc } from "jsonc-parser";
import { createFsFromVolume, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigEnv } from "#src/config-layer.ts";
import { loadAiGuardConfig, persistConfigLayer } from "#src/config-layer.ts";
import { configSchema } from "#src/config-schema.ts";

vi.mock("node:fs", () => createFsFromVolume(vol));

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
      config: { ...fullConfig, provider: "anthropic", mode: "lenient" },
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
      config: { ...fullConfig, mode: "yolo" } as never,
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
      config: withJunk as never,
    });
    expect(result.created).toBe(true);
    const written = JSON.parse(
      vol.readFileSync("/agent/extensions/pi-permission-ai-guard/config.jsonc", "utf-8") as string,
    );
    expect(written).toEqual(fullConfig);
    expect("junk" in written).toBe(false);
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
