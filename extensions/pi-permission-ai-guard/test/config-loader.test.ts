import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAiGuardConfig } from "#src/config-loader.ts";

vi.mock("node:fs", async () => {
  const { createFsFromVolume } = await import("memfs");
  return createFsFromVolume(vol);
});

describe("loadAiGuardConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("returns undefined config when no files exist", () => {
    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
    expect(result.config?.provider).toBe("anthropic"); // from global
    expect(result.config?.model).toBe("project-model"); // overridden by project
  });

  it("records issue on malformed JSON", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": "{ invalid json",
    });

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]!.message).toContain("Failed to read");
  });

  it("records issue on non-object JSON", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": "[]",
    });

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("uses defaults from cwd when options omitted", () => {
    // This just tests it doesn't throw — it will read from the real
    // ~/.pi/agent dir or not, depending on the test environment.
    expect(() => loadAiGuardConfig()).not.toThrow();
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
    const result = loadAiGuardConfig({
      cwd: "/project",
      agentDir: "/agent",
      trustedProject: false,
    });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent", trustedProject: true });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent", trustedProject: true });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
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

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
    expect(result.config).toBeUndefined();
    expect(result.issues.some((i) => i.path === "mode")).toBe(true);
  });

  it("warns on the auto + breaker-defer combination (legal but interrupts)", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        mode: "auto",
        circuitBreaker: { verdict: "defer" },
      }),
    });

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
    // The config itself is valid — the escape valve is a designed feature.
    expect(result.config?.mode).toBe("auto");
    expect(result.config?.circuitBreaker.verdict).toBe("defer");
    const warning = result.issues.find((i) => i.path === "mode");
    expect(warning?.message).toContain("circuitBreaker.verdict");
  });

  it("does not warn on auto with the default breaker deny", () => {
    vol.fromJSON({
      "/agent/extensions/pi-permission-ai-guard/config.json": JSON.stringify({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        mode: "auto",
      }),
    });

    const result = loadAiGuardConfig({ cwd: "/project", agentDir: "/agent" });
    expect(result.issues).toEqual([]);
  });
});
