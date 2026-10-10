/**
 * The kit's dispatch surface: `canDecorate` (the renderer table's
 * membership test) and `renderersFor` (the one dispatch through
 * `RENDERER_FACTORIES`). The table's `Record<ToolName, RendererFactory>`
 * is the compile-time proof of exhaustiveness; these pin the runtime
 * edges — membership for every schema name, the built triple, and the
 * throw on a name the schema does not know (unreachable through the
 * resolver, since the gate yields unknown names first).
 */

import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "#src/config/config-schema.ts";
import { createRenderKit } from "#src/render/kit.ts";

/** The isolated session roots (no config files, no user themes). */
const ENV = {
  cwd: "/nonexistent-kit-test/project",
  agentDir: "/nonexistent-kit-test/agent",
};

describe("kit dispatch surface", () => {
  it("canDecorate accepts every schema name and nothing else", async () => {
    const kit = await createRenderKit(ENV);
    for (const name of TOOL_NAMES) expect(kit.canDecorate(name)).toBe(true);
    expect(kit.canDecorate("nope")).toBe(false);
    expect(kit.canDecorate("")).toBe(false);
  });

  it("renderersFor throws on a name the schema does not know", async () => {
    const kit = await createRenderKit(ENV);
    expect(() => kit.renderersFor("nope", undefined)).toThrowError(/cannot decorate "nope"/);
  });

  it("renderersFor builds a triple for a known name", async () => {
    const kit = await createRenderKit(ENV);
    const triple = kit.renderersFor("bash", undefined);
    expect(typeof triple.renderCall).toBe("function");
    expect(typeof triple.renderResult).toBe("function");
  });
});
