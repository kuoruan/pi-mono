import { describe, expect, it } from "vitest";

// Session isolation: registerTools must not read the developer's real
// config layers (a global disabledTools/syntaxTheme would flip this
// suite). A fixed path that exists nowhere — the config layers simply
// find no file (a missing layer is skipped by design).
const isolatedDir = "/nonexistent-pi-pigment-find-isolation";

import { globAnchor } from "#src/render/tool-find.ts";
import {
  buildRenderTheme,
  type DrivenTaskComponent,
  makeRenderCtx,
  plain,
  registerTools,
  waitFor,
  type TextComponent,
} from "#test/fixtures.ts";

/**
 * Count fg-escape OPENINGS in a line — the discriminator between plain
 * type coloring (one opening per line) and anchor emphasis (an extra
 * fgCode + re-open per hit.
 *
 * @param line - The rendered line.
 * @returns The number of truecolor fg openings.
 */
// eslint-disable-next-line no-control-regex -- intentionally matches ESC
const fgOpenings = (line: string): number => (line.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length;

describe("find result rendering", () => {
  it("styles paths by type: dim dirname + colored basename", { timeout: 20000 }, async () => {
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const find = tools.find((t) => t.name === "find");
    if (!find?.renderResult) throw new Error("find not registered");
    const { ctx } = makeRenderCtx();
    const component = find.renderResult(
      {
        content: [
          {
            type: "text",
            text: "src/render/tool-ls.ts\nsrc/theme/palette.ts\ndocs/adr/\ncomponents/\nREADME.md\nbinary\n",
          },
        ],
        isError: false,
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    component.render(120);
    await waitFor(() => (plain(component.text.text).length > 0 ? true : undefined));
    const text = component.text.text;
    // Directories (nested AND top-level): the visible name appears exactly
    // once — dim prefix + accent+bold name, no doubled path (a past bug
    // rendered "docs/adr/docs/adr"; toContain alone cannot catch it).
    for (const line of plain(text).split("\n")) {
      expect((line.match(/docs\/adr/g) ?? []).length).toBe(line.includes("docs/adr") ? 1 : 0);
      expect((line.match(/components/g) ?? []).length).toBe(line.includes("components") ? 1 : 0);
    }
    expect(plain(text)).toContain("docs/adr/");
    expect(plain(text)).toContain("components/");
    // Code files: the fgCode tint (buildRenderTheme carries the palette).
    expect(plain(text)).toContain("src/render/tool-ls.ts");
    expect(text).toContain("\x1b[38;2;");
    // Non-code file: toolOutput color, no crash.
    expect(plain(text)).toContain("README.md");
    expect(plain(text)).toContain("binary");
  });

  it("passes through limit-free bodies and the empty result", async () => {
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const find = tools.find((t) => t.name === "find");
    if (!find?.renderResult) throw new Error("find not registered");
    const { ctx } = makeRenderCtx();
    // No limit details: the body renders whole (a trailing bracketed line
    // without details is just the text — the notice pin lives in the
    // "limit notices" suite above).
    const body = find.renderResult(
      {
        content: [{ type: "text", text: "a.ts\nb.ts" }],
        isError: false,
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    body.render(120);
    await waitFor(() => (plain(body.text.text).includes("b.ts") ? true : undefined));
    expect(plain(body.text.text)).toContain("a.ts");

    const empty = find.renderResult(
      { content: [{ type: "text", text: "No files found matching pattern" }], isError: false },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    empty.render(120);
    await waitFor(() => (plain(empty.text.text).includes("No files found") ? true : undefined));
    expect(plain(empty.text.text)).toContain("No files found matching pattern");
  });
});

describe("powershell wrapper", () => {
  it(
    "renders the command in powershell grammar with the PS> prompt",
    { timeout: 20000 },
    async () => {
      const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
      const ps = tools.find((t) => t.name === "powershell");
      if (!ps?.renderCall) throw new Error("powershell not registered");
      const { ctx, invalidated } = makeRenderCtx();
      const streaming = ps.renderCall(
        { command: "Get-ChildIte" },
        buildRenderTheme(),
        ctx,
      ) as TextComponent;
      expect(plain(streaming.text.text)).toContain("PS> Get-ChildIte");

      ps.renderCall({ command: "Get-ChildItem -Recurse" }, buildRenderTheme(), ctx);
      await waitFor(() => (invalidated.count > 0 ? true : undefined));
      const settled = ps.renderCall(
        { command: "Get-ChildItem -Recurse" },
        buildRenderTheme(),
        ctx,
      ) as DrivenTaskComponent;
      expect(settled.text.text).toContain("\x1b[38;2;");
      expect(plain(settled.text.text)).toContain("PS> Get-ChildItem -Recurse");
    },
  );
});

describe("globAnchor character classes (metacharacter wholesale)", () => {
  it("never anchors a class's inner text ([lL]icense contributes no run)", () => {
    // The class matches one char of "lL" — as a literal substring "lL"
    // appears in no filename. Only the class-free remainder can anchor.
    expect(globAnchor("[lL]icense.ts")).toBe("icense.ts");
    expect(globAnchor("src/[a-z]attern.h")).toBe("attern.h");
    expect(globAnchor("[abc]")).toBe("");
    // Flanking text survives as independent runs (partial-match anchors).
    expect(globAnchor("just[a]file")).toBe("just");
  });
});

describe("limit notices (the SDK's structured details)", () => {
  it("renders the notice from details as the warning footer, never as a path", async () => {
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const find = tools.find((t) => t.name === "find");
    if (!find?.renderResult) throw new Error("find not registered");
    const { ctx } = makeRenderCtx();
    // The SDK's real find result: the notice as the text's last line AND
    // the same fact in details (find.js sets both in one path).
    const limited = find.renderResult(
      {
        content: [
          {
            type: "text",
            text: "src/a.ts\nsrc/b.ts\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]",
          },
        ],
        details: { resultLimitReached: 1000 },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    limited.render(120);
    await waitFor(() => (plain(limited.text.text).includes("src/a.ts") ? true : undefined));
    const text = plain(limited.text.text);
    const lines = text.split("\n");
    // The paths are body rows from line 0; the
    // notice is the footer's last line — no `a.ts/` styling bleed, and
    // no notice-shaped path row.
    expect(lines[0]).toContain("src/a.ts");
    expect(lines[1]).toContain("src/b.ts");
    expect(lines[lines.length - 1]).toBe(
      "[1000 results limit reached. Use limit=2000 for more, or refine pattern]",
    );
  });

  it("keeps a bracketed FILENAME a path (details is the authority, never the text shape)", async () => {
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const find = tools.find((t) => t.name === "find");
    if (!find?.renderResult) throw new Error("find not registered");
    const { ctx } = makeRenderCtx();
    // No details: `[note].md` is an ordinary result path, whatever it
    // looks like (the regex era could not tell them apart from anatomy
    // alone; the structured field can).
    const plainResult = find.renderResult(
      { content: [{ type: "text", text: "[note].md\nsrc/index.ts" }] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    plainResult.render(120);
    await waitFor(() => (plain(plainResult.text.text).includes("index.ts") ? true : undefined));
    expect(plain(plainResult.text.text)).toContain("[note].md");
  });
});

describe("globAnchor (the actual anchor strings)", () => {
  it("anchors the full final segment, stems only, longest brace alternative", () => {
    expect(globAnchor("**/handlers.ts")).toBe("handlers.ts");
    expect(globAnchor("handlers.ts")).toBe("handlers.ts");
    expect(globAnchor("src/**/profile.h")).toBe("profile.h");
    // Brace alternatives split: "handlers"/"index" are stem runs, ".ts"
    // the shared suffix (no stem) — the anchor is the longest alternative.
    expect(globAnchor("{handlers,index}.ts")).toBe("handlers");
    expect(globAnchor("*.ts")).toBe(""); // no stem
    expect(globAnchor("*.spec.ts")).toBe(""); // extension chain, no stem
    expect(globAnchor("*")).toBe("");
    expect(globAnchor("config.json")).toBe("config.json");
  });
});

describe("find hit emphasis (glob anchor)", () => {
  it("emphasizes the glob's anchor run in basenames", async () => {
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const find = tools.find((tool) => tool.name === "find");
    if (!find?.renderResult || !find.renderCall) throw new Error("find not registered");
    const { ctx } = makeRenderCtx();
    // The anchor comes from the settled args (read in renderResult); a
    // handlers glob anchors "handlers" (the star-run is stripped, the
    // extension drops).
    ctx.args = { pattern: "**/handlers.ts" };
    const component = find.renderResult(
      {
        content: [{ type: "text", text: "src/handlers.ts\nlib/other.ts\nsrc/xhandlers.ts" }],
        isError: false,
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    component.render(120);
    await waitFor(() => (plain(component.text.text).length > 0 ? true : undefined));
    const text = plain(component.text.text);
    // All three rows render (content passes through).
    expect(text).toContain("src/handlers.ts");
    expect(text).toContain("lib/other.ts");
    // The anchor emphasis brightened "handlers" in matching basenames.
    component.render(120);
    await waitFor(() => (plain(component.text.text).length > 0 ? true : undefined));
    const raw = component.text.text;
    const handlersLine = raw.split("\n").find((l) => plain(l).includes("src/handlers.ts"));
    expect(fgOpenings(handlersLine!)).toBeGreaterThan(1); // type color + emphasis
    const xhandlersLine = raw.split("\n").find((l) => plain(l).includes("xhandlers.ts"));
    expect(fgOpenings(xhandlersLine!)).toBeGreaterThan(1); // substring hit counts
    const otherLine = raw.split("\n").find((l) => plain(l).includes("lib/other.ts"));
    expect(fgOpenings(otherLine!)).toBe(1); // type color only — no anchor hit
  });

  it("pure extension globs carry no anchor (nothing emphasized)", async () => {
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const find = tools.find((tool) => tool.name === "find");
    if (!find?.renderResult || !find.renderCall) throw new Error("find not registered");
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "*.ts" };
    const component = find.renderResult(
      { content: [{ type: "text", text: "src/a.ts" }], isError: false },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    component.render(120);
    await waitFor(() => (plain(component.text.text).includes("src/a.ts") ? true : undefined));
    // "*.ts" strips to nothing usable — no emphasis, plain type coloring.
    expect(fgOpenings(component.text.text)).toBe(1); // plain type coloring only
  });
});
