import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadPigmentConfig } from "#src/config/config-layer.ts";
import { configSchema } from "#src/config/config-schema.ts";
import { isRootHex } from "#src/theme/palette.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

const AGENT_DIR = "/agent";
const CWD = "/project";

// The agent dir ALREADY sits under the config dir (`~/.pi/agent`) — the
// global layer is agentDir/extensions/pigment, no extra `.pi` segment
// (the project layer below DOES carry it).
const GLOBAL_PATH = `${AGENT_DIR}/extensions/pigment/config.jsonc`;
const PROJECT_PATH = `${CWD}/.pi/extensions/pigment/config.jsonc`;

function env() {
  return { cwd: CWD, agentDir: AGENT_DIR };
}

beforeEach(() => {
  vol.reset();
});

describe("loadPigmentConfig", () => {
  it("returns schema defaults when no config file exists", () => {
    const { config, issues } = loadPigmentConfig(env());
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues).toEqual([]);
  });

  it("reads the global layer", () => {
    writeFile(GLOBAL_PATH, JSON.stringify({ indicatorStyle: "none" }));
    const { config, issues } = loadPigmentConfig(env());
    expect(config.indicatorStyle).toBe("none");
    expect(config.disabledTools).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("reads the project layer", () => {
    writeFile(PROJECT_PATH, JSON.stringify({ disabledTools: ["write"] }));
    const { config } = loadPigmentConfig(env());
    expect(config.disabledTools).toEqual(["write"]);
  });

  it("reads syntaxTheme strings verbatim — name resolution is theme-resolver's job", () => {
    writeFile(GLOBAL_PATH, JSON.stringify({ syntaxTheme: "catppuccin" }));
    expect(loadPigmentConfig(env()).config.syntaxTheme).toBe("catppuccin");
    // Any string passes the schema (name resolution happens later).
    writeFile(PROJECT_PATH, JSON.stringify({ syntaxTheme: "nord-light" }));
    expect(loadPigmentConfig(env()).config.syntaxTheme).toBe("nord-light");
  });

  it("accepts a syntaxTheme object through the schema", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        syntaxTheme: {
          base: "catppuccin",
          colors: { keyword: "#ff7b72" },
          diff: { added: { text: "#3fb950" } },
          dark: { diff: { removed: { text: "#3d1d1d" } } },
        },
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    expect(config.syntaxTheme).toEqual({
      base: "catppuccin",
      colors: { keyword: "#ff7b72" },
      diff: { added: { text: "#3fb950" } },
      dark: { diff: { removed: { text: "#3d1d1d" } } },
    });
    expect(issues).toEqual([]);
  });

  it("rejects a variant-mode object without color-carrying variants (single-key fallback)", () => {
    // No base and no variant colors: neither patch nor variant mode — the refine
    // fails and ONLY syntaxTheme falls back to auto.
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        syntaxTheme: { diff: { added: { text: "#3fb950" } } },
        indicatorStyle: "none",
        disabledTools: ["write"],
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    expect(config.syntaxTheme).toBe("auto");
    expect(config.indicatorStyle).toBe("none"); // other keys survive
    expect(config.disabledTools).toEqual(["write"]);
    const messages = issues.map((issue) => issue.message).join("\n");
    expect(messages).toMatch(/syntaxTheme/);
    expect(messages).toMatch(/"base"/);
  });

  it("falls back the whole config only for non-syntaxTheme failures", () => {
    writeFile(GLOBAL_PATH, JSON.stringify({ indicatorStyle: "bogus", syntaxTheme: "catppuccin" }));
    const { config, issues } = loadPigmentConfig(env());
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues.map((issue) => issue.message).join("\n")).toMatch(/indicatorStyle/);
  });

  it("rejects invalid hex colors and diff-only variants in variant mode", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({ syntaxTheme: { base: "auto", colors: { keyword: "red" } } }),
    );
    expect(loadPigmentConfig(env()).config.syntaxTheme).toBe("auto");

    // Variant mode: a diff-only variant (no colors) trips the refine.
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({ syntaxTheme: { dark: { diff: { added: { text: "#3fb950" } } } } }),
    );
    const { config, issues } = loadPigmentConfig(env());
    expect(config.syntaxTheme).toBe("auto");
    expect(issues.map((issue) => issue.message).join("\n")).toMatch(/"base"/);
  });

  it("deep-merges syntaxTheme objects across layers", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({ syntaxTheme: { base: "auto", colors: { keyword: "#ff0000" } } }),
    );
    writeFile(PROJECT_PATH, JSON.stringify({ syntaxTheme: { colors: { string: "#00ff00" } } }));
    const { config } = loadPigmentConfig(env());
    expect(config.syntaxTheme).toEqual({
      base: "auto",
      colors: { keyword: "#ff0000", string: "#00ff00" },
    });
  });

  it("project overrides global on conflicts", () => {
    writeFile(GLOBAL_PATH, JSON.stringify({ indicatorStyle: "none", disabledTools: ["write"] }));
    writeFile(PROJECT_PATH, JSON.stringify({ indicatorStyle: "bar" }));
    const { config } = loadPigmentConfig(env());
    expect(config.indicatorStyle).toBe("bar");
    expect(config.disabledTools).toEqual(["write"]); // untouched keys survive
  });

  it("deep-merges nested objects", () => {
    writeFile(GLOBAL_PATH, JSON.stringify({ nested: { a: 1, b: 2 } }));
    writeFile(PROJECT_PATH, JSON.stringify({ nested: { b: 3 } }));
    const { config, issues } = loadPigmentConfig(env());
    // The schema is strict: unknown keys surface as issues (a mistyped
    // key silently doing nothing is worse), and the merge itself must not
    // throw — the valid keys still apply.
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toMatch(/nested/);
  });

  it("prefers config.jsonc when both file names exist", () => {
    writeFile(
      GLOBAL_PATH.replace("config.jsonc", "config.json"),
      JSON.stringify({ indicatorStyle: "none" }),
    );
    writeFile(GLOBAL_PATH, JSON.stringify({ indicatorStyle: "bar" }));
    const { config } = loadPigmentConfig(env());
    expect(config.indicatorStyle).toBe("bar");
  });

  it("parses JSONC with comments and trailing commas", () => {
    writeFile(PROJECT_PATH, `{\n  // which tools to skip\n  "disabledTools": ["edit",],\n}`);
    const { config, issues } = loadPigmentConfig(env());
    expect(config.disabledTools).toEqual(["edit"]);
    expect(issues).toEqual([]);
  });

  it("records an issue and skips a malformed layer", () => {
    writeFile(GLOBAL_PATH, "{ not json");
    writeFile(PROJECT_PATH, JSON.stringify({ indicatorStyle: "none" }));
    const { config, issues } = loadPigmentConfig(env());
    expect(config.indicatorStyle).toBe("none");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("global");
  });

  it("survives BOTH layers malformed (defaults, two issues)", () => {
    writeFile(GLOBAL_PATH, "{ not json");
    writeFile(PROJECT_PATH, "{ also not json");
    const { config, issues } = loadPigmentConfig(env());
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/global/);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/project/);
  });

  it("records an issue when the root is not an object", () => {
    writeFile(GLOBAL_PATH, '["not", "an", "object"]');
    const { config, issues } = loadPigmentConfig(env());
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues).toHaveLength(1);
  });

  it("falls back to schema defaults on schema violations", () => {
    writeFile(GLOBAL_PATH, JSON.stringify({ indicatorStyle: "classic", disabledTools: ["bash"] }));
    const { config, issues } = loadPigmentConfig(env());
    // Unknown enum value and unknown tool are rejected: defaults apply.
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((issue) => issue.message.includes("indicatorStyle"))).toBe(true);
  });

  it("an invalid global layer alone keeps defaults", () => {
    writeFile(GLOBAL_PATH, "{ oops");
    const { config, issues } = loadPigmentConfig(env());
    expect(config).toEqual({ disabledTools: [], indicatorStyle: "bar", syntaxTheme: "auto" });
    expect(issues).toHaveLength(1);
  });
});

describe("diff root shape (the single home, ADR 0003 lockstep)", () => {
  it("slots every root structurally; both intakes key off the same shape", () => {
    // The key IS the semantics: text takes the opaque forms, tint takes
    // the alpha-carrying forms — a misplaced form fails, never silently
    // reinterprets.
    expect(isRootHex("tint", "#3fb9504d")).toBe(true);
    expect(isRootHex("text", "#3fb9504d")).toBe(false);
    // The zod schema mirrors the nested DiffRoots shape (a new side or
    // slot surfaces on the config surface without a second edit).
    const parsed = configSchema.safeParse({
      syntaxTheme: {
        base: "auto",
        diff: {
          added: { tint: "#12345666", text: "#123456" },
          removed: { tint: "#12345666", text: "#123456" },
        },
      },
    });
    expect(parsed.success).toBe(true);
    // A 6-digit tint / 8-digit base fails at load with the slot in the path.
    const bad = configSchema.safeParse({
      syntaxTheme: { base: "auto", diff: { added: { tint: "#3fb950" } } },
    });
    expect(bad.success).toBe(false);
  });

  it("accepts the CSS shorthand per slot: #rgb text, #rgba tint", () => {
    expect(isRootHex("text", "#3fb")).toBe(true);
    expect(isRootHex("tint", "#3fb9")).toBe(true);
    // A 3-digit tint carries no alpha channel — the tint ladder's whole
    // point — so it stays rejected; a 4-digit text is translucent, which
    // the opaque text slot refuses (the same line the 6/8-digit forms draw).
    expect(isRootHex("tint", "#3fb")).toBe(false);
    expect(isRootHex("text", "#3fb9")).toBe(false);
    const parsed = configSchema.safeParse({
      syntaxTheme: { base: "auto", diff: { added: { text: "#3fb", tint: "#3fb9" } } },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("diff root hex formats (ADR 0003)", () => {
  it("accepts 6-digit opaque and 8-digit translucent roots", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        syntaxTheme: {
          base: "auto",
          diff: { added: { tint: "#3fb9504d" }, removed: { text: "#ff7b72" } },
        },
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    expect(issues).toEqual([]);
    expect(config.syntaxTheme).toEqual({
      base: "auto",
      diff: { added: { tint: "#3fb9504d" }, removed: { text: "#ff7b72" } },
    });
  });

  it("rejects translucent text roots (ADR 0003: text never composites)", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        syntaxTheme: {
          base: "auto",
          diff: { added: { text: "#3fb95080" }, removed: { tint: "#f8514966" } },
        },
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    // Single-key fallback: syntaxTheme → auto, the issue names the rule.
    expect(config.syntaxTheme).toBe("auto");
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/added\.text/);
    expect(messages).toMatch(/must be an opaque #rrggbb/);
  });

  it("still rejects malformed root values", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        syntaxTheme: { base: "auto", diff: { added: { tint: "green" } } },
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    // syntaxTheme falls back to auto (single-key fallback); other keys survive.
    expect(config.syntaxTheme).toBe("auto");
    expect(issues.map((i) => i.message).join("\n")).toMatch(/must be a #rrggbbaa/);
  });

  it("keeps semantic colors 6-digit only (translucent syntax colors are meaningless)", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        syntaxTheme: { base: "auto", colors: { comment: "#5c63704d" } },
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    expect(config.syntaxTheme).toBe("auto"); // rejected → fallback
    expect(issues.length).toBeGreaterThan(0);
  });

  it("old root keys fail loudly but other config keys survive (single-key fallback)", () => {
    writeFile(
      GLOBAL_PATH,
      JSON.stringify({
        disabledTools: ["bash"],
        syntaxTheme: { base: "auto", diff: { addedFg: "#ff8800" } },
      }),
    );
    const { config, issues } = loadPigmentConfig(env());
    expect(config.disabledTools).toEqual(["bash"]); // survives
    expect(config.syntaxTheme).toBe("auto"); // falls back
    expect(issues.map((i) => i.message).join("\n")).toMatch(/addedFg/);
  });
});
