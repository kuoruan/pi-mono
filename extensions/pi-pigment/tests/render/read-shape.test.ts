import { dirname, join as joinPath } from "node:path";

import { getReadmePath } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createReadWrapper } from "#src/render/tool-read.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  type RenderCallCarrier,
  type RenderResultCarrier,
  makeRenderCtx,
  makeRenderSession,
  plain,
  resetPigmentForTest,
  viewFor,
  makeServices,
  type TextDouble,
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
  const component = (tool.renderCall as unknown as RenderCallCarrier["renderCall"])(
    args,
    buildRenderTheme(),
    ctx,
  );
  return plain(component.text.text);
}

describe("read call header", () => {
  it("renders the path", () => {
    expect(readCallText({ path: "src/a.ts" }, true)).toContain("src/a.ts");
  });

  it("inerts escape sequences in the path arg (no OSC through the header)", () => {
    // A hostile path: raw ESC/OSC would ride pigment's own hyperlink out.
    const evil = "src/\x1b]0;pwned\x07a.ts";
    const text = readCallText({ path: evil }, true);
    expect(text).not.toContain("\x1b]0;");
    expect(text).not.toContain("\x07");
    expect(text).toContain("src/");
  });

  it("appends the line range", () => {
    expect(readCallText({ path: "src/a.ts", offset: 10, limit: 20 }, true)).toContain(":10-29");
  });

  it("pins the range in the suffix so truncation never eats it", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper(
      { name: "read" } as never,
      makeServices({ headerEllipsis: "on" }),
    );
    const { ctx } = makeRenderCtx();
    const command = { path: `src/${"deep-".repeat(30)}a.ts`, offset: 10, limit: 20 };
    ctx.args = command;
    ctx.expanded = false;
    const component = (tool.renderCall as unknown as RenderCallCarrier["renderCall"])(
      command,
      buildRenderTheme(),
      ctx,
    ) as TextDouble;
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes(":10-29")) throw new Error("waiting");
    });
    // The path truncates but the range survives (the suffix never
    // enters the ellipsis budget).
    expect(plain(component.text.text)).toContain("…");
    expect(plain(component.text.text)).toContain(":10-29");
  });

  it("collapses SKILL.md to a skill label", () => {
    const header = readCallText({ path: "/x/foo/SKILL.md" }, false);
    expect(header).toContain("✦ foo");
    expect(header).toContain("skill");
  });

  it("marks pi-docs origins so SDK paths never pose as project files", () => {
    // The pi package root (getReadmePath): a docs/ path under it
    // collapses with the [pi] origin mark.
    const header = readCallText(
      { path: joinPath(dirname(getReadmePath()), "docs/config.md") },
      false,
    );
    expect(header).toContain("[pi]");
    expect(header).toContain("config.md");
  });

  it("collapses AGENTS.md to a resource label", () => {
    expect(readCallText({ path: "/x/AGENTS.md" }, false)).toContain("read resource");
  });

  it("collapses SKILL.md case-insensitively", () => {
    expect(readCallText({ path: "/x/foo/SKILL.MD" }, false)).toContain("✦ foo");
  });

  it("collapses lockfiles to a generated label", () => {
    const header = readCallText({ path: "/x/pnpm-lock.yaml" }, false);
    expect(header).toContain("read generated");
    expect(header).toContain("pnpm-lock.yaml");
  });

  it("flags secret-bearing files in the suffix", () => {
    const header = readCallText({ path: "/x/.env" }, false);
    expect(header).toContain("⚠ sensitive");
    expect(readCallText({ path: "/x/app.ts" }, false)).not.toContain("sensitive");
  });

  it("masks dotenv values in the body, keeping key names", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/.env" };
    ctx.expanded = true;
    const result = {
      content: [
        { type: "text", text: "API_KEY=sk-live-abc123\nGITHUB_TOKEN=abc\nEMPTY=\n# comment=yes\n" },
      ],
    };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("API_KEY")) throw new Error("waiting");
    });
    const body = plain(component.text.text);
    expect(body).toContain("API_KEY=sk****");
    expect(body).not.toContain("sk-live-abc123");
    // Short values collapse fully; empties and comments pass through.
    expect(body).toContain("GITHUB_TOKEN=****");
    expect(body).toContain("EMPTY=");
    expect(body).toContain("# comment=yes");
  });

  it("masks export-prefixed and quoted dotenv values, leaves JSON bodies alone", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/.env" };
    ctx.expanded = true;
    const result = {
      content: [
        { type: "text", text: 'export FOO=barbar\nQUOTED="secret-value"\n{"key": "raw"}\n' },
      ],
    };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildFakeTheme(),
      ctx,
    );
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("FOO")) throw new Error("waiting");
    });
    const body = plain(component.text.text);
    // export prefix + quoted values mask (quotes ride the head/value split).
    expect(body).not.toContain("barbar");
    expect(body).not.toContain("secret-value");
    // JSON object lines are not dotenv assignments — banner-only by design.
    expect(body).toContain('"key"');
  });

  it("leaves non-secret bodies byte-identical", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/app.ts" };
    ctx.expanded = true;
    const raw = "const a = 1;\nurl = http://x;\n";
    const result = { content: [{ type: "text", text: raw }] };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("const a")) throw new Error("waiting");
    });
    expect(plain(component.text.text)).toContain("const a = 1;");
    expect(plain(component.text.text)).toContain("url = http://x;");
  });

  it("expands tabs before highlight (pi-tui renders a tab as three spaces)", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/Makefile" };
    ctx.expanded = true;
    const result = { content: [{ type: "text", text: "target:\n\tcmd\n" }] };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildFakeTheme(),
      ctx,
    );
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("target:")) throw new Error("waiting");
    });
    const body = plain(component.text.text);
    expect(body).toContain("   cmd");
    expect(body).not.toContain("\t");
  });

  it("renders an empty file as an empty body (no orphan gutter)", async () => {
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/empty.ts" };
    ctx.expanded = true;
    const result = { content: [{ type: "text", text: "" }] };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildFakeTheme(),
      ctx,
    );
    component.render(120);
    // The empty body renders empty (renderEmpty — no preview task, no
    // orphan gutter line).
    expect(component.previewTask).toBeUndefined();
    expect(plain(component.text.text)).toBe("");
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
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
    const wrapped = await (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
  return createReadWrapper({ name: "read" } as never, makeServices());
}

describe("read collapse and seed", () => {
  it("returns to the folded preview on expand-then-collapse", async () => {
    resetPigmentForTest();
    const tool = wrapperFor();
    const fakeTheme = buildFakeTheme({ syntaxColors: true });
    viewFor(fakeTheme);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "src/a.ts" };
    ctx.expanded = true;
    const renderResult = tool.renderResult as unknown as RenderResultCarrier["renderResult"];
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
      const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
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

  it("lifts the user-limit tail notice to the footer", async () => {
    // The SDK appends `[N more lines in file…]` after exactly `limit`
    // content rows (read.js, user-limit branch) — it rides the footer,
    // never a guttered body row. No disk involved: the count decides.
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/big.ts", limit: 3 };
    ctx.expanded = true;
    const result = {
      content: [
        {
          type: "text",
          text: "line1\nline2\nline3\n\n[149 more lines in file. Use offset=4 to continue.]",
        },
      ],
    };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = plain(component.text.text);
      if (!body.includes("more lines in file") || !/^\s*1\s/m.test(body)) {
        throw new Error("waiting for styled frame");
      }
    });
    // The notice stands alone in the tail — no gutter number on its row.
    const noticeRows = body.split("\n").filter((line) => line.includes("more lines in file"));
    expect(noticeRows).toHaveLength(1);
    expect(noticeRows[0]).not.toMatch(/^\s*\d+\s/);
  });

  it.each([
    // No `limit`: a bracketed tail line is file content, full stop.
    { args: { path: "/x/notes.ts" }, text: "a\n[see docs for more]" },
    // `limit` passed but the window is short: the file ended inside
    // the window, so the SDK emits no notice — same verdict.
    { args: { path: "/x/notes.ts", limit: 5 }, text: "a\n[see docs for more]" },
  ])("keeps a bracketed tail line as content ($args.path $args.limit)", async ({ args, text }) => {
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = args;
    ctx.expanded = true;
    const result = { content: [{ type: "text", text }] };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = plain(component.text.text);
      if (!/^\s*1\s/m.test(body)) throw new Error("waiting for styled frame");
    });
    expect(body).toContain("[see docs for more]");
  });

  it("drops the truncation tail notice (the footer carries the synthesis)", async () => {
    // The SDK appends `[Showing lines X-Y…]` beside details.truncation
    // — the body drops it, the footer keeps `[Truncated:…]` once.
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/big.ts" };
    ctx.expanded = true;
    const result = {
      content: [{ type: "text", text: "a\nb\n\n[Showing lines 1-2 of 5.]" }],
      details: { truncation: { truncated: true, truncatedBy: "lines" } },
    };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = plain(component.text.text);
      if (!body.includes("Truncated")) throw new Error("waiting for notice");
    });
    expect(body).not.toContain("Showing lines");
    expect(body).toContain("Truncated");
  });

  it("image results render the note with no line numbers", async () => {
    // The SDK marks image reads with an image block (read.js); the text
    // note is not file text, so a `1` gutter would be noise.
    resetPigmentForTest();
    const tool = createReadWrapper({ name: "read" } as never, makeServices());
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/x/photo.png" };
    ctx.expanded = true;
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    };
    const component = (tool.renderResult as unknown as RenderResultCarrier["renderResult"])(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    component.render(120);
    let body = "";
    await vi.waitFor(() => {
      body = plain(component.text.text);
      if (!body.includes("Read image file")) throw new Error("waiting for note");
    });
    // The note line stands alone — no gutter number prefix.
    expect(body.split("\n").filter((line) => line.includes("Read image file"))).toHaveLength(1);
    expect(body).not.toMatch(/^\s*1\s/m);
  });
});
