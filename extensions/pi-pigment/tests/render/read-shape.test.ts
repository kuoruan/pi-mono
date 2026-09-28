import { describe, expect, it, vi } from "vitest";

import { createReadWrapper } from "#src/render/tool-read.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  type DrivenTaskComponent,
  type TaskCarrier,
  makeRenderCtx,
  makeRenderSession,
  plain,
  resetPigmentForTest,
  viewFor,
} from "#test/fixtures.ts";

function readCallText(args: unknown, expanded: boolean): string {
  resetPigmentForTest();
  const tool = createReadWrapper(
    { name: "read" } as never,
    {
      render: makeRenderSession(),
      shortPath: (p: string) => p,
      indicatorStyle: "bar",
      headerEllipsis: "off",
    } as never,
  );
  const { ctx } = makeRenderCtx();
  ctx.args = args;
  ctx.expanded = expanded;
  const component = (
    tool.renderCall as unknown as (a: unknown, t: unknown, c: unknown) => { text: { text: string } }
  )(args, buildRenderTheme(), ctx);
  return plain(component.text.text);
}

describe("read call header", () => {
  it("renders the path", () => {
    expect(readCallText({ path: "src/a.ts" }, true)).toContain("src/a.ts");
  });

  it("appends the line range", () => {
    expect(readCallText({ path: "src/a.ts", offset: 10, limit: 20 }, true)).toContain(":10-29");
  });

  it("collapses SKILL.md to a skill label", () => {
    expect(readCallText({ path: "/x/foo/SKILL.md" }, false)).toContain("[skill]");
  });

  it("collapses AGENTS.md to a resource label", () => {
    expect(readCallText({ path: "/x/AGENTS.md" }, false)).toContain("read resource");
  });
});

describe("read result body", () => {
  it("shows the first lines folded, the full slice expanded", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper(
      { name: "read" } as never,
      {
        render: makeRenderSession(),
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        headerEllipsis: "off",
      } as never,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts" };
    ctx.expanded = false;
    const component = (
      tool.renderResult as unknown as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: unknown,
      ) => DrivenTaskComponent & TaskCarrier
    )(
      {
        content: [
          { type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n" },
        ],
      },
      { expanded: false, isPartial: false },
      buildFakeTheme({ syntaxColors: true }),
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = component.text.text;
      if (!plain(body).includes("const a")) throw new Error("waiting for preview");
    });
    // Three preview lines, the fourth folded behind the tail.
    expect(plain(body)).toContain("const c");
    expect(plain(body)).not.toContain("const d");
    // The bat-style numbers gutter (muted, after highlight): the fake
    // Text host never swaps the preview task, so run it directly.
    const styled = await component.previewTask!.render(120);
    expect(plain(styled)).toMatch(/1\s+const a/);
    // The settled frame keeps the tail: the folded expand hint survives
    // the Shiki swap (the F1 regression hid it).
    expect(plain(styled)).toContain("1 more line");
    expect(plain(styled)).not.toContain("const d");
    // The read gutter is number + ONE space (the diff sign column
    // collapses — a read carries no sign).
    expect(plain(styled)).toMatch(/^\s*1 const a/m);
    // Soft-wrapped continuation rows repeat the gutter's blank shape
    // (no bare column-zero wrap): a long line refolds under its number.
    const long = `const ${"x".repeat(200)} = 1;\n`;
    const wrapped = await (
      tool.renderResult as unknown as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: unknown,
      ) => DrivenTaskComponent & TaskCarrier
    )(
      { content: [{ type: "text", text: long }] },
      { expanded: false, isPartial: false },
      buildFakeTheme({ syntaxColors: true }),
      ctx,
    ).previewTask!.render(40);
    const wrappedLines = plain(wrapped).split("\n");
    expect(wrappedLines.length).toBeGreaterThan(1);
    expect(wrappedLines[1]).toMatch(/^\s+\S/);
    expect(wrappedLines[1]).not.toMatch(/^\S/);
  });

  it("previews compact labels folded too (the label names it, the preview proves it)", async () => {
    resetPigmentForTest();
    const tool = wrapperFor();
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "AGENTS.md" };
    ctx.expanded = false;
    const component = (
      tool.renderResult as unknown as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: unknown,
      ) => DrivenTaskComponent
    )(
      { content: [{ type: "text", text: "# a\n# b\n# c\n# d\n" }] },
      { expanded: false, isPartial: false },
      fakeTheme,
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = component.text.text;
      if (!plain(body).includes("# a")) throw new Error("waiting for preview");
    });
    expect(plain(body)).toContain("# c");
    expect(plain(body)).not.toContain("# d");
  });

  it("highlights the expanded slice in the file's language", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper(
      { name: "read" } as never,
      {
        render: makeRenderSession(),
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        headerEllipsis: "off",
      } as never,
    );
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts" };
    ctx.expanded = true;
    const component = (
      tool.renderResult as unknown as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: unknown,
      ) => DrivenTaskComponent
    )(
      { content: [{ type: "text", text: "const answer = 42;\n" }] },
      { expanded: true, isPartial: false },
      fakeTheme,
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = component.text.text;
      // eslint-disable-next-line no-control-regex -- waits for the Shiki pass
      if (!/\x1b\[38;2;/.test(body)) throw new Error("waiting for highlight");
    });
    // The keyword carries a Shiki token color (not plain toolOutput).
    expect(body).toMatch(/38;2;\d+;\d+;\d+mconst/);
    expect(plain(body)).toContain("const answer = 42;");
  });

  it("shows the SDK truncation notice", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper(
      { name: "read" } as never,
      {
        render: makeRenderSession(),
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        headerEllipsis: "off",
      } as never,
    );
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts" };
    ctx.expanded = true;
    const component = (
      tool.renderResult as unknown as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: unknown,
      ) => DrivenTaskComponent & TaskCarrier
    )(
      {
        content: [{ type: "text", text: "const a = 1;\n" }],
        details: {
          truncation: {
            content: "",
            truncated: true,
            truncatedBy: "lines",
            totalLines: 300,
            totalBytes: 1000,
            outputLines: 200,
            outputBytes: 800,
            firstLineExceedsLimit: false,
            maxLines: 200,
            maxBytes: 100000,
          },
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = component.text.text;
      if (!body.includes("Truncated")) throw new Error("waiting for notice");
    });
    expect(plain(body)).toContain("[Truncated: showing 200 of 300 lines (200 line limit)]");
    // The settled frame keeps the notice too (the F1 regression dropped
    // it on the Shiki swap).
    const styled = await component.previewTask!.render(120);
    expect(plain(styled)).toContain("[Truncated: showing 200 of 300 lines (200 line limit)]");
  });
});

/**
 * The wrapper under test (no scope capture — module level).
 *
 * @returns The read wrapper.
 */
function wrapperFor() {
  return createReadWrapper(
    { name: "read" } as never,
    {
      render: makeRenderSession(),
      shortPath: (p: string) => p,
      indicatorStyle: "bar",
      headerEllipsis: "off",
    } as never,
  );
}

describe("read collapse and seed", () => {
  type ResultFn = (r: unknown, o: unknown, t: unknown, c: unknown) => DrivenTaskComponent;

  it("returns to the folded preview on expand-then-collapse", async () => {
    resetPigmentForTest();
    const tool = wrapperFor();
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts" };
    ctx.expanded = true;
    const renderResult = tool.renderResult as unknown as ResultFn;
    const host = renderResult(
      { content: [{ type: "text", text: "const a = 1;\n" }] },
      { expanded: true, isPartial: false },
      fakeTheme,
      ctx,
    );
    host.render(120);
    await vi.waitFor(() => {
      // eslint-disable-next-line no-control-regex -- waits for the Shiki pass
      if (!/\x1b\[38;2;/.test(host.text.text)) throw new Error("waiting for highlight");
    });
    // Collapse reuses the host: the full slice swaps back to the
    // folded preview (same host, preview task re-armed).
    ctx.expanded = false;
    const folded = renderResult(
      { content: [{ type: "text", text: "const a = 1;\n" }] },
      { expanded: false, isPartial: false },
      fakeTheme,
      { ...ctx, lastComponent: host },
    );
    expect(folded).toBe(host);
    folded.render(120);
    await vi.waitFor(() => {
      if (!plain(folded.text.text).includes("const a")) throw new Error("waiting for preview");
    });
  });

  it("seeds an offset slice of an embedded grammar from disk", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pigment-read-"));
    try {
      const full = "<template><div>\n<span>x</span>\n</div></template>\n";
      writeFileSync(join(dir, "a.vue"), full);
      resetPigmentForTest();
      const tool = wrapperFor();
      const fakeTheme = buildFakeTheme({ syntaxColors: true });
      viewFor(fakeTheme);
      const { ctx } = makeRenderCtx();
      ctx.cwd = dir;
      ctx.args = { path: "a.vue", offset: 2, limit: 1 };
      ctx.expanded = true;
      const component = (tool.renderResult as unknown as ResultFn)(
        { content: [{ type: "text", text: "<span>x</span>\n" }] },
        { expanded: true, isPartial: false },
        fakeTheme,
        ctx,
      );
      component.render(120);
      await vi.waitFor(() => {
        if (!plain(component.text.text).includes("span")) throw new Error("waiting for body");
      });
      // The disk seed landed in the row state (the edit-precedent memo).
      expect((ctx.state as { seedText?: string }).seedText).toContain("<template>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the disk read for a plain language with an offset", async () => {
    resetPigmentForTest();
    const tool = wrapperFor();
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts", offset: 5, limit: 1 };
    ctx.expanded = true;
    const component = (tool.renderResult as unknown as ResultFn)(
      { content: [{ type: "text", text: "const a = 1;\n" }] },
      { expanded: true, isPartial: false },
      fakeTheme,
      ctx,
    );
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("const")) throw new Error("waiting for body");
    });
    expect((ctx.state as { seedText?: string }).seedText).toBeUndefined();
  });

  it("shows the first-line-exceeds notice", async () => {
    resetPigmentForTest();
    const tool = wrapperFor();
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts" };
    ctx.expanded = true;
    const component = (tool.renderResult as unknown as ResultFn)(
      {
        content: [{ type: "text", text: "x\n" }],
        details: {
          truncation: {
            content: "",
            truncated: true,
            truncatedBy: "bytes",
            totalLines: 10,
            totalBytes: 200000,
            outputLines: 1,
            outputBytes: 100000,
            firstLineExceedsLimit: true,
            maxLines: 200,
            maxBytes: 100000,
          },
        },
      },
      { expanded: true, isPartial: false },
      fakeTheme,
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = component.text.text;
      if (!body.includes("First line exceeds")) throw new Error("waiting for notice");
    });
    expect(plain(body)).toContain("First line exceeds");
  });

  it("renders the invalid chip for a non-string path", () => {
    expect(readCallText({ path: 42 }, true)).toContain("invalid");
  });
});
