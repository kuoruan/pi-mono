import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { resolveDiffPalette } from "#src/theme/palette.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  registerTools,
  resetPigmentForTest,
  waitFor,
  toolOf,
  plain,
  type TaskCarrier,
  type TextComponent,
  type TextDouble,
} from "#test/fixtures.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

/**
 * Count the distinct truecolor fg escapes in a render — the coloring
 * diversity signal (an unstyled render carries one; a tokenized script
 * block carries several).
 */
// eslint-disable-next-line no-control-regex -- intentionally matches ESC
const FG_ESCAPE_RE = /\x1b\[38;2;\d+;\d+;\d+m/g;
function countFgEscapes(s: string): Set<string> {
  return new Set(s.match(FG_ESCAPE_RE) ?? []);
}

describe("grammar-state seeding (embedded grammars)", () => {
  it("colors a vue script hunk that shows no <script> tag (the partial-diff bug)", async () => {
    resetPigmentForTest();
    const sfc = [
      "<template>",
      "  <div class='hello'>{{ msg }}</div>",
      "</template>",
      "",
      '<script setup lang="ts">',
      "import { ref } from 'vue';",
      "",
      "const count = ref(0);",
      "const msg = 'hello';",
      "",
      "function inc() {",
      "  count.value += 1;",
      "}",
      "</script>",
      "",
      "<style scoped>",
      ".hello { color: red; }",
      "</style>",
    ].join("\n");
    const edited = sfc.replace("const msg = 'hello';", "const msg = 'world';");
    // The hunk: 3 context lines above/below the change — all inside the
    // script block, no tag line in view.
    const diff = parseDiff(sfc, edited, 3);
    // Sanity: no line of the visible hunk contains a tag.
    for (const line of diff.lines) {
      expect(line.content).not.toMatch(/<(script|template|style)/);
    }
    // Seed: the file text before the hunk (what the write wrapper slices
    // from args.content via the first hunk's newStart).
    const firstChange = diff.lines.find((l) => l.newNum !== null);
    const start = firstChange?.newNum ?? 1;
    const seed = sfc
      .split("\n")
      .slice(0, start - 1)
      .join("\n");

    // A pi theme WITH the nine syntax colors — the auto syntax theme
    // derives from them (buildRenderTheme carries none, so everything
    // would render in the unstyled gray).
    const theme = buildFakeTheme({ syntaxColors: true });
    const palette = resolveDiffPalette(theme);
    const seeded = await renderUnified({
      diff,
      language: "vue",
      maxLines: 50,
      width: 120,
      palette,
      piTheme: theme,
      indicator: "bar",
      seed,
    });
    const unseeded = await renderUnified({
      diff,
      language: "vue",
      maxLines: 50,
      width: 120,
      palette,
      piTheme: theme,
      indicator: "bar",
    });

    // The property: the seeded render colors tokens (multiple distinct fg
    // escapes over the script lines), the unseeded one is flat — this is
    // exactly the "vue partial diff renders uncolored" report.
    const fgEscapes = (s: string): Set<string> => countFgEscapes(s);
    expect(fgEscapes(seeded).size).toBeGreaterThan(3);
    expect(fgEscapes(unseeded).size).toBeLessThan(fgEscapes(seeded).size);
    // And the script content itself survived the render (token boundaries
    // split it in the styled form — the plain form still carries the line).
    expect(plain(seeded)).toContain("count.value += 1;");
  });
});

describe("rendering pipeline", () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vol.reset();
    tempDir = "/render-project";
    vol.mkdirSync(tempDir, { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    process.env.PI_CODING_AGENT_DIR = "/render-agent";
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    delete process.env.PI_CODING_AGENT_DIR;
    vol.reset();
  });

  it("write renderCall shows the tool header", { timeout: 20000 }, async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderCall) throw new Error("write.renderCall missing");

    // Existing file → "write" header; missing file → "create" header.
    const existing = join(tempDir, "app.ts");
    vol.writeFileSync(existing, "const x = 0;\n");

    const { ctx } = makeRenderCtx();
    const component = write.renderCall(
      { path: existing, content: "const x = 1;\n" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;

    expect(component.text.text).toContain("write");
    expect(component.text.text).toContain("app.ts");

    const createCtx = makeRenderCtx();
    const createComponent = write.renderCall(
      { path: join(tempDir, "missing.ts"), content: "const y = 1;\n" },
      buildRenderTheme(),
      createCtx.ctx,
    ) as TextComponent;
    expect(createComponent.text.text).toContain("create");
  });

  it("write renderResult schedules and renders a highlighted diff", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    const filePath = join(tempDir, "changed.ts");
    vol.writeFileSync(filePath, "const value = 1;\nconst other = 2;\n");
    const diff = parseDiff(
      "const value = 1;\nconst other = 2;\n",
      "const value = 10;\nconst other = 2;\n",
    );

    const { ctx } = makeRenderCtx();
    const component = write.renderResult(
      {
        content: [{ type: "text", text: "Successfully wrote" }],
        isError: false,
        details: {
          kind: "diff",
          filePath,
          diff,
          language: "typescript",
        },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as {
      previewTask?: { render: (width: number) => Promise<string> };
      text: { text: string };
    };

    // Sync phase: the async preview task is scheduled on the component.
    expect(component.previewTask).toBeDefined();
    const rendered = await component.previewTask!.render(120);

    // The full pipeline ran: parse → Shiki highlight → diff bg injection.
    expect(rendered).toContain("\x1b[");
    expect(plain(rendered)).toContain("const value = 10;");
    expect(rendered).toMatchInlineSnapshot(`
      "[48;2;30;30;40m[0m[48;2;30;30;40m[38;2;200;100;100m▌[0m[48;2;30;30;40m[48;2;59;38;38m[38;2;200;100;100m 1[0m[48;2;30;30;40m[48;2;59;38;38m [38;2;200;100;100m-[48;2;59;38;38m [0m[48;2;30;30;40m[48;2;69;43;43m[38;2;179;179;179mconst value = [48;2;96;55;55m1[48;2;69;43;43m;[39m[48;2;69;43;43m[0m[48;2;30;30;40m[48;2;69;43;43m                                      [0m[48;2;30;30;40m[38;2;100;180;120m▌[0m[48;2;30;30;40m[48;2;37;45;48m[38;2;100;180;120m 1[0m[48;2;30;30;40m[48;2;37;45;48m [38;2;100;180;120m+[48;2;37;45;48m [0m[48;2;30;30;40m[48;2;41;53;52m[38;2;179;179;179mconst value = [48;2;51;75;64m10[48;2;41;53;52m;[39m[48;2;41;53;52m[0m[48;2;30;30;40m[48;2;41;53;52m                                     [0m[48;2;30;30;40m
      [48;2;30;30;40m[0m[48;2;30;30;40m[48;2;30;30;40m [48;2;30;30;40m[38;2;128;128;128m 2[0m[48;2;30;30;40m[48;2;30;30;40m [38;2;128;128;128m [48;2;30;30;40m [0m[48;2;30;30;40m[48;2;30;30;40m[2m[38;2;179;179;179mconst other = 2;[39m[48;2;30;30;40m                                      [0m[48;2;30;30;40m[48;2;30;30;40m [48;2;30;30;40m[38;2;128;128;128m 2[0m[48;2;30;30;40m[48;2;30;30;40m [38;2;128;128;128m [48;2;30;30;40m [0m[48;2;30;30;40m[48;2;30;30;40m[2m[38;2;179;179;179mconst other = 2;[39m[48;2;30;30;40m                                      [0m[48;2;30;30;40m"
    `);
  });

  it("write new-file body opens the code area on the add-row background", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    const filePath = join(tempDir, "fresh.ts");
    const { ctx } = makeRenderCtx();
    // kind "new" derives its content from the call args at render time.
    (ctx as unknown as { args: unknown }).args = {
      path: filePath,
      content: "const value = 1;\n",
    };
    const component = write.renderResult(
      {
        isError: false,
        details: { kind: "new", filePath },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as {
      previewTask?: { render: (width: number) => Promise<string> };
      text: { text: string };
    };
    const rendered = await component.previewTask!.render(120);
    // The gutter row-resets onto the canvas (30;30;40); the code area
    // must then open on the add-row bg (bgAdded = canvas ⊕
    // toolDiffAdded at 15% = 41;53;52) — hlBlock's spans are fg-only,
    // so without this prefix the highlighted content would render on
    // the canvas (reading as white in the light frame) instead of the
    // add-row tint.
    expect(rendered).toContain("\x1b[0m\x1b[48;2;30;30;40m\x1b[48;2;41;53;52m");
    expect(plain(rendered)).toContain("const value = 1;");
  });

  it("the new-file stats memo reuses per-frame stats and re-derives on new args", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    const filePath = join(tempDir, "fresh-memo.ts");
    const { ctx } = makeRenderCtx();
    (ctx as unknown as { args: unknown }).args = {
      path: filePath,
      content: "const a = 1;\n",
    };
    const result = { isError: false, details: { kind: "new", filePath } } as never;
    write.renderResult(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    const state = (
      ctx as unknown as {
        state: { newFileStats?: { content: string; lineCount: number; fingerprint: number } };
      }
    ).state;
    const first = state.newFileStats;
    expect(first).toBeDefined();
    expect(first!.lineCount).toBe(1);
    // The settled args' content reference is stable frame to frame: the
    // next renderResult must reuse the memo (the perf claim's hit path).
    write.renderResult(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    expect(state.newFileStats).toBe(first);
    // A fresh args parse (new reference) re-derives the stats.
    (ctx as unknown as { args: unknown }).args = {
      path: filePath,
      content: "const a = 1;\nconst b = 2;\n",
    };
    write.renderResult(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    expect(state.newFileStats).not.toBe(first);
    expect(state.newFileStats!.lineCount).toBe(2);
  });

  it("edit renderResult renders the actual matched diff", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit.renderResult) throw new Error("edit.renderResult missing");

    const filePath = join(tempDir, "edit-target.ts");
    vol.writeFileSync(filePath, "const a = 1;\n");

    const { ctx } = makeRenderCtx();
    ctx.args = { path: filePath }; // the language source
    const component = edit.renderResult(
      {
        content: [{ type: "text", text: "edited" }],
        isError: false,
        details: {
          // The SDK's own EditToolDetails shape — execute delegates
          // verbatim, renderResult parses the patch lazily.
          diff: "",
          patch: "--- app.ts\n+++ app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
          firstChangedLine: 1,
        },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as {
      previewTask?: { render: (width: number) => Promise<string> };
      text: { text: string };
    };

    expect(component.previewTask).toBeDefined();
    const rendered = await component.previewTask!.render(120);
    expect(rendered).toContain("\x1b[");
    expect(plain(rendered)).toContain("const a = 2;");
    expect(rendered).toMatchInlineSnapshot(
      `"[48;2;30;30;40m[0m[48;2;30;30;40m[38;2;200;100;100m▌[0m[48;2;30;30;40m[48;2;59;38;38m[38;2;200;100;100m 1[0m[48;2;30;30;40m[48;2;59;38;38m [38;2;200;100;100m-[48;2;59;38;38m [0m[48;2;30;30;40m[48;2;69;43;43m[38;2;179;179;179mconst a = [48;2;96;55;55m1[48;2;69;43;43m;[39m[48;2;69;43;43m[0m[48;2;30;30;40m[48;2;69;43;43m                                          [0m[48;2;30;30;40m[38;2;100;180;120m▌[0m[48;2;30;30;40m[48;2;37;45;48m[38;2;100;180;120m 1[0m[48;2;30;30;40m[48;2;37;45;48m [38;2;100;180;120m+[48;2;37;45;48m [0m[48;2;30;30;40m[48;2;41;53;52m[38;2;179;179;179mconst a = [48;2;51;75;64m2[48;2;41;53;52m;[39m[48;2;41;53;52m[0m[48;2;30;30;40m[48;2;41;53;52m                                          [0m[48;2;30;30;40m"`,
    );
  }, 15000);

  it("edit renderResult works from the SDK's own details shape (ADR 0005 compat)", async () => {
    // The primary path IS the SDK shape now: execute delegates verbatim,
    // so every pi-pigment-created session result — live, restored, or opened
    // without pi-pigment — carries { diff, patch, firstChangedLine }. The
    // renderer parses the patch lazily and attaches the preview task.
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit.renderResult) throw new Error("edit.renderResult missing");

    const { ctx } = makeRenderCtx();
    ctx.args = { path: join(tempDir, "app.ts") };
    const component = edit.renderResult(
      {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in app.ts." }],
        isError: false,
        details: {
          diff: "-1 const a = 1;\n+1 const a = 42;\n 2 const b = 2;",
          patch:
            "--- app.ts\n+++ app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 42;\n const b = 2;\n",
          firstChangedLine: 1,
        },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as {
      previewTask?: { render: (width: number) => Promise<string> };
      text: { text: string };
    };

    expect(component.previewTask).toBeDefined();
    const rendered = await component.previewTask!.render(120);
    expect(plain(rendered)).toContain("const a = 42;");
    // The stats bridge stashed the counts for the call header.
    expect(ctx.state.added).toBe(1);
    expect(ctx.state.removed).toBe(1);
  });

  it("edit renderResult degrades to plain text on an unparseable patch", async () => {
    // The old crash guard stays relevant: a malformed patch (or details
    // the SDK changed shape on) must fall back to plain text, never hand
    // a string to the preview task (TypeError: diff.lines.length crash).
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit.renderResult) throw new Error("edit.renderResult missing");

    const { ctx } = makeRenderCtx();
    ctx.args = { path: join(tempDir, "app.ts") };
    const component = edit.renderResult(
      {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in app.ts." }],
        isError: false,
        details: { diff: "", patch: "not a unified diff", firstChangedLine: 1 },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as {
      previewTask?: unknown;
      text: { text: string };
    };

    expect(component.previewTask).toBeUndefined();
    expect(component.text.text).toContain("Successfully replaced");
  });

  it("renderResult falls back to plain text when details are absent", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    const { ctx } = makeRenderCtx();
    const component = write.renderResult(
      {
        content: [{ type: "text", text: "Successfully wrote 42 bytes" }],
        isError: false,
        details: undefined,
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;

    expect(component.text.text).toContain("Successfully wrote");
  });

  it("factory wraps the component so render(width) drives the diff task end-to-end", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    const { ctx, lastComponent } = makeRenderCtx();
    const component = write.renderResult(
      {
        content: [{ type: "text", text: "written" }],
        isError: false,
        details: {
          kind: "diff",
          diff: parseDiff("const a = 1;\n", "const a = 2;\n"),
          language: "typescript",
        },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as unknown as TextDouble;

    // The TUI drives components through render(width) — the wrapper must
    // run the attached task through that path (bare components render
    // diffs blank).
    const firstPass = component.render(120);
    expect(plain(firstPass.join("\n"))).toContain("rendering diff");
    await waitFor(() => {
      const text = (lastComponent as TextComponent).text.text;
      return plain(text).includes("const a = 2;") ? text : undefined;
    });
    const settled = (lastComponent as TextComponent).text.text;
    expect(plain(settled)).toContain("const a = 2;");
    expect(plain(settled)).toContain("const a = 1;");
  }, 15000);
});

describe("wrap and separator paths (own isolation via registerTools defaults)", () => {
  it("wraps long lines across rows with continuation gutters (unified path)", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    // Add-only diff (split impossible) with a line far wider than the code
    // column: the wrap engine must break it across rows.
    const long = `const payload = { ${"field: 'value', ".repeat(16)}};`;
    const diff = parseDiff("", `${long}\n`);
    const { ctx } = makeRenderCtx();
    const component = write.renderResult(
      {
        content: [{ type: "text", text: "written" }],
        isError: false,
        details: { kind: "diff", diff, language: "typescript" as never },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TaskCarrier;
    const rendered = await component.previewTask!.render(180);
    const rows = rendered.split("\n");
    // The long line consumed multiple wrapped rows (the original report
    // rendered it as one overlong row).
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      // ANSI-aware: every row stays within the render width.
      const width = row.replace(
        new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
        "",
      ).length;
      expect(width).toBeLessThanOrEqual(180);
    }
  }, 20000);

  it("renders split-view hunk separators with truncated labels (fitAnsi path)", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    if (!write.renderResult) throw new Error("write.renderResult missing");

    // Two balanced change hunks far apart → between-hunk separator in the
    // split view, its label truncated to the code width (fitAnsi).
    const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[5] = "line five changed";
    newLines[30] = "line thirty changed";
    const diff = parseDiff(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`, 2);
    const { ctx } = makeRenderCtx();
    const component = write.renderResult(
      {
        content: [{ type: "text", text: "written" }],
        isError: false,
        details: { kind: "diff", diff, language: "typescript" as never },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TaskCarrier;
    const rendered = await component.previewTask!.render(120);
    const text = rendered.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    expect(text).toContain("line five changed");
    expect(text).toContain("line thirty changed");
    // A between-hunk separator carried the skipped-lines label.
    expect(text).toMatch(/\+\d+ lines/);
  }, 20000);
});
