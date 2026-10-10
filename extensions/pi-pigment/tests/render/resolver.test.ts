/**
 * The renderer resolver's contract with pi's renderer chain: yield by
 * returning `next()` (the remaining resolvers, then the built-in
 * renderers), decorate by returning a fresh triple. The chain position is
 * what every yield rule preserves — an unknown name, a foreign-owned name,
 * the FFF signal, a missing kit, and `disabledTools` all hand the name
 * back untouched.
 */

import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetCurrentKitForTest, setCurrentKit } from "#src/render/current-kit.ts";
import { createRenderKit } from "#src/render/kit.ts";
import { createPigmentToolRendererResolver } from "#src/render/resolver.ts";

/** The isolated session roots (no config files, no user themes). */
const ENV = {
  cwd: "/nonexistent-resolver-test/project",
  agentDir: "/nonexistent-resolver-test/agent",
};

/**
 * A fake `pi` registry surface.
 *
 * @param tools - Registry entries (name + source).
 * @param commands - Command names visible.
 * @returns The minimal API the resolver reads.
 */
function fakePi(
  tools: Array<{ name: string; source?: string }> = [],
  commands: string[] = [],
): Parameters<typeof createPigmentToolRendererResolver>[0] {
  const registry = tools.map(
    (tool) =>
      ({
        name: tool.name,
        sourceInfo: { source: tool.source ?? "builtin", path: "<test>" },
      }) as unknown as ToolInfo,
  );
  return {
    getAllTools: () => registry,
    getCommands: () => commands.map((name) => ({ name }) as never),
  } as never;
}

/** The built-in renderer triple a yield must hand back by reference. */
const ORIG: ToolRenderers = {
  renderShell: "default",
  renderCall: (() => ({ kind: "builtin-call" })) as never,
  renderResult: (() => ({ kind: "builtin-result" })) as never,
};

beforeEach(() => {
  resetCurrentKitForTest();
});

describe("resolver yield chain", () => {
  it("yields an unknown name without touching the registry", () => {
    const resolver = createPigmentToolRendererResolver(fakePi());
    expect(resolver("some_other_tool", () => ORIG)).toBe(ORIG);
  });

  it("fails safe to next() when no kit exists yet", () => {
    const resolver = createPigmentToolRendererResolver(fakePi());
    expect(resolver("bash", () => ORIG)).toBe(ORIG);
  });

  it("yields a name another extension owns", async () => {
    setCurrentKit(await createRenderKit(ENV));
    const resolver = createPigmentToolRendererResolver(fakePi([{ name: "bash", source: "local" }]));
    expect(resolver("bash", () => ORIG)).toBe(ORIG);
  });

  it("yields a name in disabledTools", async () => {
    setCurrentKit(await createRenderKit({ ...ENV, config: { disabledTools: ["bash"] } }));
    const resolver = createPigmentToolRendererResolver(fakePi());
    expect(resolver("bash", () => ORIG)).toBe(ORIG);
  });

  it("yields grep/find on the fff-mode command signal", async () => {
    setCurrentKit(await createRenderKit(ENV));
    const resolver = createPigmentToolRendererResolver(fakePi([], ["fff-mode"]));
    expect(resolver("grep", () => ORIG)).toBe(ORIG);
    expect(resolver("find", () => ORIG)).toBe(ORIG);
    // The signal is scoped to search — the other names still decorate.
    expect(resolver("ls", () => ORIG)).not.toBe(ORIG);
  });

  it("ignores builtin-sourced entries (a builtin name alone never yields)", async () => {
    setCurrentKit(await createRenderKit(ENV));
    const resolver = createPigmentToolRendererResolver(
      fakePi([{ name: "bash", source: "builtin" }]),
    );
    expect(resolver("bash", () => ORIG)).not.toBe(ORIG);
  });

  it("decorates a known name with a fresh triple composed over next()", async () => {
    setCurrentKit(await createRenderKit(ENV));
    const resolver = createPigmentToolRendererResolver(fakePi());
    const resolved = resolver("bash", () => ORIG);
    expect(resolved).not.toBe(ORIG);
    expect(resolved?.renderShell).toBe("default");
    expect(typeof resolved?.renderCall).toBe("function");
    expect(typeof resolved?.renderResult).toBe("function");
  });

  it("delegates bash output rendering to next()'s renderResult", async () => {
    setCurrentKit(await createRenderKit(ENV));
    const spy = vi.fn<() => unknown>(() => ({ kind: "builtin-result" }));
    const orig: ToolRenderers = { ...ORIG, renderResult: spy as never };
    const resolver = createPigmentToolRendererResolver(fakePi());
    const resolved = resolver("bash", () => orig);
    resolved?.renderResult?.(
      { content: [{ type: "text", text: "output" }] } as never,
      { expanded: true, isPartial: false } as never,
      {
        fg: (_: string, t: string) => t,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        bg: (_: string, t: string) => t,
        bold: (t: string) => t,
      } as never,
      {
        lastComponent: undefined,
        args: {},
        state: {},
        expanded: false,
        invalidate: () => {},
        isError: false,
        argsComplete: true,
        isPartial: false,
        executionStarted: false,
        cwd: ENV.cwd,
      } as never,
    );
    expect(spy).toHaveBeenCalledOnce();
  });

  it("returns a defined triple composed over undefined next()", async () => {
    setCurrentKit(await createRenderKit(ENV));
    const resolver = createPigmentToolRendererResolver(fakePi());
    // Last in the chain, next() has nothing to hand back — decoration
    // must still produce a usable triple, not undefined.
    const resolved = resolver("bash", () => undefined);
    expect(resolved).not.toBeUndefined();
    expect(resolved?.renderShell).toBe("default");
    expect(typeof resolved?.renderCall).toBe("function");
    expect(typeof resolved?.renderResult).toBe("function");
  });

  it("fails safe to next() when our own renderer construction throws", async () => {
    // A throw here would propagate through pi's resolveToolRenderers (no
    // guard in the SDK) into the TUI's render dispatch. ADR 0005: our bug
    // must never break pi's rendering — degrade to pi's own renderers.
    const kit = await createRenderKit(ENV);
    setCurrentKit({
      ...kit,
      renderersFor: () => {
        throw new Error("renderer exploded");
      },
    });
    const resolver = createPigmentToolRendererResolver(fakePi());
    expect(() => resolver("bash", () => ORIG)).not.toThrow();
    expect(resolver("bash", () => ORIG)).toBe(ORIG);
  });

  it("pins gate order: foreign/FFF/disabled all precede the kit", async () => {
    // The kit exists with bash disabled — but a foreign owner also holds
    // the name: the yield must hand back next()'s value BY REFERENCE.
    setCurrentKit(await createRenderKit({ ...ENV, config: { disabledTools: ["bash"] } }));
    const resolver = createPigmentToolRendererResolver(
      fakePi([{ name: "bash", source: "local" }], ["fff-mode"]),
    );
    // Foreign + disabled both hold; the gating checks run before the kit
    // decorates, so the raw next() value returns untouched.
    expect(resolver("bash", () => ORIG)).toBe(ORIG);
    // FFF present, grep enabled, kit present: the FFF check still yields.
    expect(resolver("grep", () => ORIG)).toBe(ORIG);
  });
});
