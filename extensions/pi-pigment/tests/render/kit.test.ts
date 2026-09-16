/**
 * The render-kit contract (ADR 0005's "yield + lend", Stage 2): what a
 * third-party extension gets from `pi-pigment/render-kit` (channel A) and
 * from the `globalThis` publication (channel B).
 *
 * The invariants worth pinning:
 *
 * 1. The published payload's key set is EXACTLY the kit's public surface.
 * 2. Borrowing REPLACES the renderers and PRESERVES the consumer's execute: a decorated grep runs the
 *    consumer's execute and renders with pi-pigment's renderer — the consumer's own renderers never
 *    run.
 * 3. The borrow renders byte-identically to the extension's own wrapper over the same session (both go
 *    through the same factory).
 * 4. An undecoratable name throws (never a silent passthrough).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import packageJson from "#root/package.json" with { type: "json" };
import { VERSION as PUBLIC_VERSION } from "#root/render-kit.ts";
import { VERSION } from "#src/package-json.ts";
import {
  createRenderKit,
  publishRenderKit,
  RENDER_KIT_KEY,
  RENDER_KIT_PROTOCOL_VERSION,
  type RenderKitPublication,
} from "#src/render/kit.ts";
import { createGrepWrapper } from "#src/render/tool-grep.ts";
import type { ToolServices } from "#src/render/tool-services.ts";
import {
  buildFakeTheme,
  makeRenderCtx,
  makeTextComponent,
  plain,
  viewFor,
  waitFor,
} from "#test/fixtures.ts";

/**
 * The published payload as a consumer sees it (through the symbol).
 *
 * @returns The payload object.
 */
function published(): RenderKitPublication {
  publishRenderKit();
  return (globalThis as Record<symbol, unknown>)[
    Symbol.for(RENDER_KIT_KEY)
  ] as RenderKitPublication;
}

/**
 * A kit over a throwaway environment (no config files, no user themes).
 *
 * @returns The pending kit.
 */
function kitFor() {
  return createRenderKit({
    cwd: "/nonexistent-project",
    agentDir: "/nonexistent-agent",
    reportIssue: () => {},
  });
}

/**
 * Run a wrapper's renderResult to a settled frame and read the text.
 *
 * The preview swap is ASYNC (`void drainPreview(text)` in text-task.ts):
 * render(120) only paints the placeholder, and the highlight lands later —
 * when the theme has no syntax colors the two frames are byte-identical,
 * so the swap itself (the invalidate) is the only reliable signal. Reading
 * before it lands would compare placeholders.
 *
 * @param tool - The wrapped definition.
 * @param result - The tool result to render.
 * @param theme - The pi theme (a syntax-colored one reaches the highlight path).
 * @returns The swapped-in frame's text.
 */
async function renderResultText(
  tool: { renderResult: (r: unknown, o: unknown, t: unknown, c: unknown) => unknown },
  result: unknown,
  theme = viewFor().piTheme,
): Promise<string> {
  const { ctx, invalidated } = makeRenderCtx<Record<string, unknown>>();
  ctx.args = { pattern: "done" };
  const component = tool.renderResult(result, { expanded: true, isPartial: false }, theme, ctx) as {
    render(w: number): string[];
    text: { text: string };
  };
  component.render(120);
  await waitFor(() => (invalidated.count > 0 ? true : undefined));
  return component.text.text;
}

describe("channel B: the globalThis publication", () => {
  it("publishes exactly the kit's public surface", () => {
    const kit = published();
    expect(Object.keys(kit).toSorted()).toEqual(
      ["createRenderKit", "createRenderSession", "packageVersion", "tools", "version"].toSorted(),
    );
    expect(kit.version).toBe(RENDER_KIT_PROTOCOL_VERSION);
    expect(kit.tools).toEqual(["write", "edit", "bash", "powershell", "grep", "ls", "find"]);
  });

  it("is idempotent — first publisher wins (/reload must not swap the payload)", () => {
    const first = published();
    expect(published()).toBe(first);
  });

  it("carries the package.json version (runtime import, no literal to drift)", () => {
    // One reader (src/package-json.ts); the facade + payload share it.
    expect(VERSION).toBe(packageJson.version);
    expect(PUBLIC_VERSION).toBe(VERSION);
    expect(published().packageVersion).toBe(VERSION);
  });

  it("is exported by the package-root facade straight from the sources (one surface, two paths)", async () => {
    const facade = await import("../../render-kit.ts");
    // The facade's runtime export list is exactly the kit's value surface.
    expect(Object.keys(facade).toSorted()).toEqual(
      [
        "VERSION",
        "RENDER_KIT_KEY",
        "RENDER_KIT_PROTOCOL_VERSION",
        "createRenderKit",
        "createRenderSession",
        "publishRenderKit",
      ].toSorted(),
    );
    // Same bindings, not copies: the facade exports the defining modules
    expect(facade.createRenderKit).toBe(createRenderKit);
    expect(facade.VERSION).toBe(VERSION);
  });
});

describe("channel A: decorate", () => {
  it("answers membership with a plain string (definition.name is string)", async () => {
    const kit = await kitFor();
    expect(kit.hasTool("grep")).toBe(true);
    expect(kit.hasTool("apply_patch")).toBe(false);
    const name: string = "grep";
    expect(kit.hasTool(name)).toBe(true);
  });

  it("keeps the consumer's execute and takes over the rendering", async () => {
    const kit = await kitFor();
    const ran: string[] = [];
    const mine = defineTool({
      name: "grep",
      label: "grep",
      description: "a consumer's own grep",
      parameters: {},
      async execute() {
        ran.push("execute");
        return {
          content: [{ type: "text" as const, text: "src.ts:1:done" }],
          isError: false,
          details: undefined,
        };
      },
      renderResult: () => {
        ran.push("renderResult");
        return makeTextComponent() as never;
      },
    });

    const decorated = kit.decorate(mine);
    expect(decorated.name).toBe("grep");

    // Execution is the consumer's (grep does not own execute in the kit).
    await decorated.execute("t1", {}, undefined, undefined, { cwd: "/project" } as never);
    expect(ran).toEqual(["execute"]);

    // Rendering is pi-pigment's: the consumer's own renderer never runs.
    // The swapped-in frame carries the highlighted hit (renderResultText
    // waits past the placeholder).
    const text = await renderResultText(
      decorated as unknown as Parameters<typeof renderResultText>[0],
      { content: [{ type: "text", text: "src.ts:1:done" }], isError: false, details: undefined },
      buildFakeTheme({ syntaxColors: true }),
    );
    expect(ran).toEqual(["execute"]);
    expect(text).not.toBe(plain(text)); // the settled frame, not the plain placeholder
    expect(plain(text)).toContain("done");
  });

  it("renders byte-identically to pi-pigment's own wrapper over the same session", async () => {
    const kit = await kitFor();
    const mine = defineTool({
      name: "grep",
      label: "grep",
      description: "a consumer's own grep",
      parameters: {},
      async execute() {
        return { content: [], isError: false, details: undefined };
      },
    });
    // The extension's own assembly path: the same factory, the same
    // session, the same services shape.
    const services = {
      shortPath: (p: string) => p,
      indicatorStyle: "bar",
      textFactory: makeTextComponent,
      render: kit.session,
    } as unknown as ToolServices;
    const own = createGrepWrapper(mine, services);
    const result = {
      content: [{ type: "text", text: "src.ts:1:done" }],
      isError: false,
      details: undefined,
    };
    // A syntax-colored theme, so the compared frames are the HIGHLIGHTED
    // ones (the placeholder swap would be vacuous without it).
    const theme = buildFakeTheme({ syntaxColors: true });
    const [borrowed, native] = await Promise.all([
      renderResultText(kit.decorate(mine) as never, result, theme),
      renderResultText(own as never, result, theme),
    ]);
    expect(borrowed).toBe(native);
    expect(borrowed).not.toBe(plain(borrowed)); // styled: the highlight ran
    expect(plain(borrowed)).toContain("src.ts:1:done");
  });

  it("throws on a name this build cannot decorate", async () => {
    const kit = await kitFor();
    expect(() =>
      kit.decorate(
        defineTool({
          name: "not-a-tool",
          label: "x",
          description: "x",
          parameters: {},
          async execute() {
            return { content: [], isError: false, details: undefined };
          },
        }),
      ),
    ).toThrow(/not-a-tool.*available tools: .*bash.*grep.*/s);
  });
});
