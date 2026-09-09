import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";

describe("CONFIG.md recipes", () => {
  it("diff-only recipe parses (base:auto + diff roots)", () => {
    const r = configSchema.safeParse({
      syntaxTheme: {
        base: "auto",
        diff: { added: { tint: "#3fb95066" } },
      },
    });
    expect(r.success).toBe(true);
  });

  it("catppuccin / disabledTools / indicatorStyle recipes parse", () => {
    expect(configSchema.safeParse({ syntaxTheme: "catppuccin" }).success).toBe(true);
    expect(configSchema.safeParse({ disabledTools: ["write"] }).success).toBe(true);
    expect(configSchema.safeParse({ indicatorStyle: "none" }).success).toBe(true);
  });
});
