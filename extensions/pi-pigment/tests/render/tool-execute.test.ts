/**
 * Tool execution and render-call coverage over the memfs volume: write/edit
 * execute paths (diff capture, new files, no-change), call-header rendering,
 * and the render branches the snapshot pipeline never drives. All fs access
 * (ours and the SDK tools') routes through the mocked volume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePatchFiles } from "#src/core/diff.ts";
import type { WriteState } from "#src/render/tool-services.ts";
import { resolveDiffPalette } from "#src/theme/palette.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  type RegisteredTool,
  resetPigmentForTest,
  type TaskCarrier,
  type TextComponent,
  waitFor,
  type TextDouble,
} from "#test/fixtures.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

const CWD = "/project";
const AGENT = "/agent-mock";

let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(CWD, { recursive: true });
  vol.mkdirSync(AGENT, { recursive: true });
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(CWD);
  process.env.PI_CODING_AGENT_DIR = AGENT;
});

afterEach(() => {
  cwdSpy.mockRestore();
  delete process.env.PI_CODING_AGENT_DIR;
});

/**
 * The registered write tool (or fails the test).
 *
 * @returns The write tool.
 */
async function writeTool(): Promise<RegisteredTool> {
  const tools = await registerTools();
  const tool = tools.find((t) => t.name === "write");
  if (!tool) throw new Error("write not registered");
  return tool;
}

/**
 * The registered edit tool (or fails the test).
 *
 * @returns The edit tool.
 */
async function editTool(): Promise<RegisteredTool> {
  const tools = await registerTools();
  const tool = tools.find((t) => t.name === "edit");
  if (!tool) throw new Error("edit not registered");
  return tool;
}

describe("write execute (memfs)", () => {
  it("captures the old/new diff for changed files", { timeout: 20000 }, async () => {
    writeFile(`${CWD}/app.ts`, "const a = 1;\n");
    const write = await writeTool();
    const result = await write.execute(
      "t1",
      { path: `${CWD}/app.ts`, content: "const a = 2;\n" },
      undefined,
      undefined,
      undefined,
    );
    const details = result.details as { kind: string; diff: { added: number; removed: number } };
    expect(details.kind).toBe("diff");
    expect(details.diff.added).toBe(1);
    expect(details.diff.removed).toBe(1);
    // The file was actually written through the SDK tool (memfs).
    expect(vol.readFileSync(`${CWD}/app.ts`, "utf-8")).toBe("const a = 2;\n");
  });

  it("marks brand-new files with the new-file detail", async () => {
    const write = await writeTool();
    const result = await write.execute(
      "t2",
      { path: `${CWD}/fresh.md`, content: "# hi\n" },
      undefined,
      undefined,
      undefined,
    );
    const details = result.details as { kind: string; filePath: string };
    expect(details.kind).toBe("new");
    expect(details.filePath).toBe(`${CWD}/fresh.md`);
    expect(vol.readFileSync(`${CWD}/fresh.md`, "utf-8")).toBe("# hi\n");
  });

  it("marks identical rewrites as noChange", async () => {
    writeFile(`${CWD}/same.ts`, "stable\n");
    const write = await writeTool();
    const result = await write.execute(
      "t3",
      { path: `${CWD}/same.ts`, content: "stable\n" },
      undefined,
      undefined,
      undefined,
    );
    // The factory's timing sideband rides along (grep/find/ls footers
    // read it); the write discriminant stays the payload.
    expect(result.details).toMatchObject({ kind: "noChange" });
    expect((result.details as Record<string, unknown>).pigmentElapsedMs).toBeTypeOf("number");
  });

  it("captures multi-line diffs with stats in the result details", async () => {
    writeFile(`${CWD}/multi.txt`, "one\ntwo\nthree\n");
    const write = await writeTool();
    const result = await write.execute(
      "t4",
      { path: `${CWD}/multi.txt`, content: "one\ntwo2\nthree\nfour\n" },
      undefined,
      undefined,
      undefined,
    );
    const details = result.details as {
      kind: string;
      diff: { added: number; removed: number; lines: unknown[] };
    };
    expect(details.kind).toBe("diff");
    expect(details.diff.added).toBe(2);
    expect(details.diff.removed).toBe(1);
  });
});

describe("write renderCall (memfs existence probes)", () => {
  it("labels a missing file 'create' and an existing file 'write'", async () => {
    writeFile(`${CWD}/exists.ts`, "x\n");
    const write = await writeTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = true;

    const created = write.renderCall?.(
      { path: `${CWD}/brand-new.ts`, content: "hi" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(plain(created.text.text)).toContain("create");

    ctx.state.existsProbes = {};
    const rewritten = write.renderCall?.(
      { path: `${CWD}/exists.ts`, content: "x2" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(plain(rewritten.text.text)).toContain("write");
  });

  it("caches the existence probe per path (one stat per path)", async () => {
    writeFile(`${CWD}/probe.ts`, "x\n");
    const write = await writeTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = true;
    write.renderCall?.({ path: `${CWD}/probe.ts`, content: "y" }, buildRenderTheme(), ctx);
    expect(ctx.state.existsProbes).toEqual({ [`${CWD}/probe.ts`]: true });
    // Flip the volume underneath: the cached probe still says true.
    vol.unlinkSync(`${CWD}/probe.ts`);
    const again = write.renderCall?.(
      { path: `${CWD}/probe.ts`, content: "z" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(plain(again.text.text)).toContain("write"); // from cache, not the volume
  });

  it("streams the (N lines…) suffix while arguments are incomplete", async () => {
    const write = await writeTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false;
    ctx.isPartial = true; // live arg streaming
    const partial = write.renderCall?.(
      { path: `${CWD}/growing.ts`, content: "a\nb\nc\n" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    // A trailing newline adds no line — the count matches what the body
    // renders (hlBlock trims one trailing newline per its line contract).
    expect(plain(partial.text.text)).toContain("(3 lines…)");
  });
});

describe("write renderResult branches (memfs)", () => {
  it("renders the no-change notice for identical content", async () => {
    writeFile(`${CWD}/nc.ts`, "same\n");
    const write = await writeTool();
    const result = await write.execute(
      "t5",
      { path: `${CWD}/nc.ts`, content: "same\n" },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx<WriteState>();
    const component = write.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TextComponent & { previewTask?: unknown };
    // The result slot is empty (the native write's success shape); the ✓
    // confirmation bridges to the header suffix and lands on the NEXT
    // call render.
    expect(plain(component.text.text)).toBe("");
    expect(component.previewTask).toBeUndefined();
    const header = write.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
    expect(plain(header.text.text)).toContain("✓ no changes");
  });

  it(
    "renders the new-file preview with the add-row number gutter",
    { timeout: 20000 },
    async () => {
      const write = await writeTool();
      const content = "export const x = 1;\nexport const y = 2;";
      const result = await write.execute(
        "t5",
        { path: `${CWD}/fresh.ts`, content },
        undefined,
        undefined,
        undefined,
      );
      const { ctx } = makeRenderCtx();
      ctx.args = { path: `${CWD}/fresh.ts`, content };
      const component = write.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        buildRenderTheme(),
        ctx,
      ) as TaskCarrier;
      const rendered = plain(await component.previewTask!.render(120));
      const body = rendered.split("\n").filter((l) => l.includes("export const"));
      expect(body.length).toBe(2);
      // The bar leads changed rows (indicatorStyle's only surface):
      // "▌ 1 + …" for adds.
      expect(body[0]).toMatch(/^▌\s*1\s*\+\s*export const x = 1;/);
      expect(body[1]).toMatch(/^▌\s*2\s*\+\s*export const y = 2;/);
    },
  );

  it(
    "folds the create preview to the native window while collapsed (ctrl+o expands)",
    { timeout: 20000 },
    async () => {
      const write = await writeTool();
      const content = Array.from({ length: 24 }, (_, i) => `const v${i} = ${i};`).join("\n");
      const result = await write.execute(
        "t6",
        { path: `${CWD}/folded.ts`, content },
        undefined,
        undefined,
        undefined,
      );
      const { ctx } = makeRenderCtx();
      ctx.args = { path: `${CWD}/folded.ts`, content };
      const collapsed = write.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        buildRenderTheme(),
        ctx,
      ) as TaskCarrier;
      const rendered = plain(await collapsed.previewTask!.render(120));
      expect(rendered.split("\n").filter((l) => /const v\d+ = /.test(l)).length).toBe(10);
      expect(rendered).toContain("14 more lines");

      // Expanded re-attaches (the key carries the expand state) and renders
      // the full body.
      const expanded = write.renderResult?.(
        result,
        { expanded: true, isPartial: false },
        buildRenderTheme(),
        ctx,
      ) as TaskCarrier;
      const full = plain(await expanded.previewTask!.render(120));
      expect(full.split("\n").filter((l) => /const v\d+ = /.test(l)).length).toBe(24);
      expect(full).not.toContain("more lines");
    },
  );

  it(
    "renders the create content exactly once: header in the call, preview in the result",
    { timeout: 20000 },
    async () => {
      const write = await writeTool();
      // Live flow: the call render runs with settled args before execute.
      const { ctx } = makeRenderCtx<WriteState>();
      ctx.args = { path: `${CWD}/live-new.ts`, content: "const a = 1;\nconst b = 2;" };
      ctx.argsComplete = true;
      ctx.isPartial = false;
      const call = write.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
      // The call slot is feedback only — the content never appears there
      // (and the ✓ summary only AFTER the result bridges it).
      expect(plain(call.text.text)).toContain("create");
      expect(plain(call.text.text)).not.toContain("const a");
      expect(plain(call.text.text)).not.toContain("✓ new file");
      const result = await write.execute("t7", ctx.args, undefined, undefined, undefined);
      const component = write.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        buildRenderTheme(),
        ctx,
      ) as TaskCarrier;
      // The result slot is the content's single home (numbered body
      // only); the ✓ summary lives in the header suffix.
      const rendered = plain(await component.previewTask!.render(120));
      expect(rendered).toContain("const a");
      expect(rendered).not.toContain("new file");
      const after = write.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
      expect(plain(after.text.text)).toContain("\u2713 new file (2 lines)");
    },
  );

  it(
    "bridges the write stats to the call header (+N −M suffix after the result)",
    { timeout: 20000 },
    async () => {
      const write = await writeTool();
      writeFile(`${CWD}/stats.ts`, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
      const result = await write.execute(
        "t9",
        { path: `${CWD}/stats.ts`, content: "const a = 1;\nconst c = 3;\n" },
        undefined,
        undefined,
        undefined,
      );
      // Live flow: renderCall first (header, no stats yet), then renderResult
      // bridges the counts, then the NEXT renderCall picks them up.
      const { ctx } = makeRenderCtx<WriteState>();
      ctx.args = { path: `${CWD}/stats.ts`, content: "const a = 1;\nconst c = 3;\n" };
      ctx.argsComplete = true;
      ctx.isPartial = false;
      const before = write.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
      expect(plain(before.text.text)).not.toMatch(/[+-]\d/);
      write.renderResult?.(result, { expanded: false, isPartial: false }, buildRenderTheme(), ctx);
      const after = write.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
      // The content dropped one line: the chip carries the removed count
      // (summarize emits only the nonzero sides).
      expect(plain(after.text.text)).toMatch(/-1\b/);
    },
  );

  it("frames every VISUAL row of a wrapped new-file preview line (gutter continuation)", async () => {
    const write = await writeTool();
    // Line 9 is long enough to wrap at a narrow render width.
    const content = Array.from({ length: 9 }, (_, i) => `line${i}`)
      .concat(["long content that definitely wraps onto the next visual row at narrow widths"])
      .join("\n");
    const result = await write.execute(
      "t-wrap",
      { path: `${CWD}/wrapped.ts`, content },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { path: `${CWD}/wrapped.ts`, content };
    const component = write.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as unknown as TextDouble;
    const rendered = plain(await component.previewTask!.render(60));
    const rows = rendered.split("\n");
    // The wrapped line's continuation rows repeat the gutter shape: the
    // bar over the blank number/sign columns ("▌   " = gutterWidth cols).
    const continuation = rows.find((r) => r.includes("narrow widths"));
    expect(continuation).toBeDefined();
    expect(continuation).toMatch(/^▌\s+\S/);
    // And the numbered first visual row still reads `▌ 10 + …`.
    expect(rows.some((r) => /^▌\s*10\s*\+/.test(r))).toBe(true);
  });

  it("attaches the new-file preview task for new files (re-attach after component loss)", async () => {
    const write = await writeTool();
    const result = await write.execute(
      "t6",
      { path: `${CWD}/preview.ts`, content: "export const x = 1;\n" },
      undefined,
      undefined,
      undefined,
    );
    // First render: task attached.
    const first = makeRenderCtx();
    first.ctx.args = { path: `${CWD}/preview.ts`, content: "export const x = 1;\n" };
    const c1 = write.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      first.ctx,
    ) as TextDouble;
    expect(c1.previewTask).toBeDefined();

    // A FRESH component (the TUI discarded the old one) re-attaches the task
    // even though the state key is unchanged (component-side guard).
    const second = makeRenderCtx();
    second.ctx.state = first.ctx.state; // same render state, new component
    second.ctx.args = first.ctx.args;
    const c2 = write.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      second.ctx,
    ) as TextDouble;
    expect(c2.previewTask).toBeDefined();
  });
});

describe("edit execute (memfs)", () => {
  it("execute delegates verbatim: SDK details ride along untouched", async () => {
    writeFile(`${CWD}/edit.ts`, "const value = 1;\n");
    const edit = await editTool();
    const result = await edit.execute(
      "t7",
      {
        path: `${CWD}/edit.ts`,
        edits: [{ oldText: "const value = 1;", newText: "const value = 42;" }],
      },
      undefined,
      undefined,
      undefined,
    );
    // ADR 0005 (amended): the session JSONL keeps the SDK's own shape —
    // no pi-pigment payload, no dropped fields. A session resumed WITHOUT
    // pi-pigment renders through the native renderer exactly as before.
    const details = result.details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(typeof details!.patch).toBe("string");
    expect(details!.patch).toContain("-const value = 1;");
    expect(details!.patch).toContain("+const value = 42;");
    expect(typeof details!.firstChangedLine).toBe("number");
    expect(details!.parsedDiff).toBeUndefined();
    expect(vol.readFileSync(`${CWD}/edit.ts`, "utf-8")).toBe("const value = 42;\n");
  });

  it("delegates errors verbatim (ambiguous match rejected by the SDK)", async () => {
    writeFile(`${CWD}/ambig.ts`, "dup\ndup\n");
    const edit = await editTool();
    await expect(
      edit.execute(
        "t8",
        { path: `${CWD}/ambig.ts`, edits: [{ oldText: "dup", newText: "uniq" }] },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/occurrences|unique/i);
  });

  it("throws for edits into missing files", async () => {
    const edit = await editTool();
    await expect(
      edit.execute(
        "t9",
        {
          path: `${CWD}/missing.ts`,
          edits: [{ oldText: "a", newText: "b" }],
        },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/ENOENT|not found|no such/i);
  });

  it("keeps multi-edit disjoint regions in one patch", async () => {
    writeFile(`${CWD}/multi.ts`, "alpha\nbeta\ngamma\n");
    const edit = await editTool();
    const result = await edit.execute(
      "t10",
      {
        path: `${CWD}/multi.ts`,
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      },
      undefined,
      undefined,
      undefined,
    );
    const parsed = parsePatchFiles(
      (result.details as { patch: string } | undefined)?.patch ?? "",
    )[0];
    expect(parsed?.added).toBe(2);
    expect(parsed?.removed).toBe(2);
    expect(vol.readFileSync(`${CWD}/multi.ts`, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\n");
  });
});

/**
 * Session-restore semantics: the TUI rebuilds tool components from history
 * WITHOUT marking args complete (no setArgsComplete on the restore path),
 * but the result is final (isPartial false). The settled-args rendering
 * branches must fire anyway — restored calls can't grow.
 */
describe("session-restore shapes (argsComplete false, isPartial false)", () => {
  it("fires the bash command highlight on restore", async () => {
    const tools = await registerTools();
    const bash = tools.find((t) => t.name === "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false; // restore never marks them
    ctx.isPartial = false; // but the result is final
    bash.renderCall({ command: "echo restored" }, buildRenderTheme(), ctx);
    // The highlight task was claimed (the staleness key carries the theme
    // identity + command) — the async swap will follow; without the
    // restore trigger this stays undefined.
    expect(ctx.state.commandHighlightFor).toContain("echo restored");
  });

  it("keeps the bash highlight idle while args still stream live", async () => {
    const tools = await registerTools();
    const bash = tools.find((t) => t.name === "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false;
    ctx.isPartial = true; // live streaming: command may still grow
    bash.renderCall({ command: "echo gro" }, buildRenderTheme(), ctx);
    expect(ctx.state.commandHighlightFor).toBeUndefined();
  });

  it("renders the edit stats header on restore (not the bare header)", async () => {
    const edit = await editTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false;
    ctx.isPartial = false;
    const component = edit.renderCall?.(
      { path: `${CWD}/restored.ts`, edits: [{ oldText: "a", newText: "b" }] },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    const text = plain(component.text.text);
    expect(text).toContain("restored.ts");
    expect(text).toContain("edit");
  });

  it("shows the edit stats suffix on restore (details + args persist, the FIFO did not)", async () => {
    writeFile(`${CWD}/restore-stats.ts`, "const a = 1;\n");
    const edit = await editTool();
    const result = await edit.execute(
      "t-restore",
      {
        path: `${CWD}/restore-stats.ts`,
        edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
      },
      undefined,
      undefined,
      undefined,
    );
    // Restored shape: a fresh state (the TUI rebuilds the row), no
    // argsComplete, a final result — exactly what /resume produces.
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false;
    ctx.isPartial = false;
    ctx.args = {
      path: `${CWD}/restore-stats.ts`,
      edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
    };
    edit.renderResult?.(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    const component = edit.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
    // The state bridge re-derives from the persisted details + args —
    // restored sessions get the suffix too.
    expect(plain(component.text.text)).toContain("1 edit");
  });

  it("renders the write header on restore (not the (N lines…) stream suffix)", async () => {
    const write = await writeTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false;
    ctx.isPartial = false;
    const component = write.renderCall?.(
      { path: `${CWD}/born-on-restore.ts`, content: "const x = 1;\n" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    const text = plain(component.text.text);
    expect(text).toContain("born-on-restore.ts");
    // The stream suffix is the live-streaming display; restore settles the
    // args and shows the framed header (the preview lives in the result).
    expect(text).not.toContain("lines…");
  });
});

describe("edit renderCall", () => {
  it("renders the edit header with path once arguments complete", async () => {
    const edit = await editTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = true;
    const component = edit.renderCall?.(
      {
        path: `${CWD}/some-file.ts`,
        edits: [{ oldText: "a", newText: "b" }],
      },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    const text = plain(component.text.text);
    expect(text).toContain("edit");
    expect(text).toContain("some-file.ts");
  });

  it("renders the bare header while arguments are incomplete", async () => {
    const edit = await editTool();
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = false;
    ctx.isPartial = true; // live arg streaming
    const component = edit.renderCall?.(
      { path: `${CWD}/partial.ts` },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    const text = plain(component.text.text);
    expect(text).toContain("partial.ts");
  });

  it("shows the stats suffix once renderResult bridges the counts (one frame later than execute)", async () => {
    writeFile(`${CWD}/stats.ts`, "const a = 1;\n");
    const edit = await editTool();
    const result = await edit.execute(
      "t-stats",
      {
        path: `${CWD}/stats.ts`,
        edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
      },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.argsComplete = true;
    ctx.args = {
      path: `${CWD}/stats.ts`,
      edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
    };
    // renderResult bridges the stats: before it runs, the header carries
    // no suffix.
    const bare = edit.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
    expect(plain(bare.text.text)).not.toContain("1 edit");
    // The result render bridges the counts from details + args…
    edit.renderResult?.(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    // …and the call header (which renders on every update) picks them up.
    const component = edit.renderCall?.(ctx.args, buildRenderTheme(), ctx) as TextComponent;
    const text = plain(component.text.text);
    expect(text).toContain("1 edit");
    expect(text).toContain("diff line");
  });
});

describe("edit renderResult fallback", () => {
  it("falls back to the result text when details carry no diff", async () => {
    const edit = await editTool();
    const { ctx } = makeRenderCtx();
    const component = edit.renderResult?.(
      { content: [{ type: "text", text: "edited something" }] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TextComponent & { previewTask?: unknown };
    expect(plain(component.text.text)).toContain("edited something");
    expect(component.previewTask).toBeUndefined();
  });
});

describe("bash renderCall", () => {
  it("stashes the command and renders the $ header", async () => {
    const tools = await registerTools();
    const bash = tools.find((t) => t.name === "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx();
    const component = bash.renderCall?.(
      { command: "echo hi" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(ctx.state.command).toBe("echo hi");
    expect(plain(component.text.text)).toContain("echo hi");
  });
});

describe("grep renderResult highlight swap", () => {
  it("swaps in highlighting asynchronously and rejects stale renders", async () => {
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult || !grep?.renderCall) throw new Error("grep not registered");
    const { ctx, invalidated } = makeRenderCtx();
    grep.renderCall({ pattern: "value" }, buildRenderTheme(), ctx);
    const output = "src/a.ts:12: const value = 1;\nsrc/b.ts:30: other value here";
    const component = grep.renderResult(
      { content: [{ type: "text", text: output }] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as {
      text: { text: string };
      render: (width: number) => string[];
      previewRenderedKey?: string;
    };
    // A render frame drives the swap protocol: the placeholder (dim/plain
    // form) lands synchronously inside render(width), the highlight swaps
    // in async — same choreography as the TUI's render loop.
    component.render(120);
    expect(plain(component.text.text)).toContain("const value = 1;");
    // Let the async highlight land (the swap invalidates).
    await waitFor(() => (invalidated.count > 0 ? true : undefined));
    const swapped = plain(component.text.text);
    expect(swapped).toContain("const value = 1;");

    // Stale guard: when the recorded key changes while a task is
    // mid-flight, the task's async completion must NOT land on the text
    // (its `previewRenderedKey === key` check fails). Drive it for real:
    // a syntax-colored theme makes the swap's landing VISIBLE (the
    // AA-enforced string color the grammar-state test above uses),
    // render starts task A, supersede the key before A's promise
    // resolves, then wait past A's completion — the highlight color must
    // never appear.
    const { ctx: staleCtx } = makeRenderCtx();
    resetPigmentForTest();
    const coloredTheme = buildFakeTheme({ syntaxColors: true });
    resolveDiffPalette(coloredTheme);
    grep.renderCall({ pattern: "value" }, coloredTheme, staleCtx);
    const stale = grep.renderResult(
      { content: [{ type: "text", text: "src/a.ts:12: const value = `tmpl`;" }] },
      { expanded: true, isPartial: false },
      coloredTheme,
      staleCtx,
    ) as {
      text: { text: string };
      render: (width: number) => string[];
      previewRenderedKey?: string;
    };
    stale.render(120); // records task A's key, lands the placeholder
    stale.previewRenderedKey = "g:superseded"; // A is mid-flight; its key is gone
    await new Promise((resolve) => setTimeout(resolve, 300)); // A completes
    // The guarded swap never landed: the key stays superseded and the
    // highlight color (the swap's landing signature) never appears.
    expect(stale.previewRenderedKey).toBe("g:superseded");
    expect(stale.text.text).not.toContain("38;2;224;185;169m");
    // Sanity: WITHOUT the poisoning the swap DOES land (the same drive
    // with an intact key delivers the color) — proving the assertion
    // above is guarding the guard, not a quirk of the theme.
    const { ctx: freshCtx } = makeRenderCtx();
    grep.renderCall({ pattern: "value" }, coloredTheme, freshCtx);
    const live = grep.renderResult(
      { content: [{ type: "text", text: "src/a.ts:12: const value = `tmpl`;" }] },
      { expanded: true, isPartial: false },
      coloredTheme,
      freshCtx,
    ) as unknown as TextDouble;
    live.render(120);
    await waitFor(() => (live.text.text.includes("38;2;224;185;169m") ? true : undefined));
    expect(live.text.text).toContain("38;2;224;185;169m");
  });

  it("a settled repeat frame skips the placeholder rebuild (the early-return guard)", async () => {
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult || !grep?.renderCall) throw new Error("grep not registered");
    const { ctx } = makeRenderCtx();
    // A counting theme: fg/bold are the payload builders the plain
    // placeholder path uses (renderPlainOutput per line + the collapse
    // tail). getFgAnsi/getBgAnsi are NOT counted — resolveDiffPalette's
    // content-validated key reads them on every frame by design.
    const base = buildRenderTheme();
    let built = 0;
    const theme = {
      ...base,
      fg: (...args: Parameters<typeof base.fg>): string => {
        built += 1;
        return base.fg(...args);
      },
      bold: (text: string): string => {
        built += 1;
        return base.bold(text);
      },
    };
    grep.renderCall({ pattern: "value" }, theme, ctx);
    const result = {
      content: [{ type: "text", text: "src/a.ts:12: const value = 1;" }],
      isError: false,
    };
    void grep.renderResult(result, { expanded: true, isPartial: false }, theme, ctx);
    const afterFirst = built;
    expect(afterFirst).toBeGreaterThan(0); // the first frame builds the placeholder
    // The settled repeat: the taskKey is unchanged, so the body must
    // early-return BEFORE the collapsedView/renderPlainOutput rebuild.
    void grep.renderResult(result, { expanded: true, isPartial: false }, theme, ctx);
    expect(built).toBe(afterFirst);
  });
});

describe("write new-file preview line cap (memfs)", () => {
  it("caps the preview at MAX_RENDER_LINES with a more-lines footer", async () => {
    const write = await writeTool();
    const big = Array.from({ length: 300 }, (_, i) => `// line ${i}`).join("\n");
    const result = await write.execute(
      "t-cap",
      { path: `${CWD}/big.ts`, content: big },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { path: `${CWD}/big.ts`, content: big };
    const component = write.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TaskCarrier;
    const rendered = await component.previewTask?.render(100);
    expect(rendered).toBeDefined();
    const text = rendered ?? "";
    expect(plain(text)).toContain("more lines");
    // 300 lines must not all render.
    // 300 input lines, MAX_RENDER_LINES (150) shown, tail/footers add a
    // few — anything near 250 means the cap leaked; anything near 300
    // means no cap at all.
    expect(plain(text).split("\n").length).toBeLessThan(250);
  });
});

describe("bash command highlighting (renderCall)", () => {
  it("renders plain while args stream, swaps in the highlighted command once complete", async () => {
    const tools = await registerTools();
    const bash = tools.find((t) => t.name === "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx, invalidated } = makeRenderCtx();

    // Streaming frame: args incomplete — the plain bold display.
    const streaming = bash.renderCall(
      { command: "git diff --st" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(plain(streaming.text.text)).toContain("$ git diff --st");
    expect(streaming.text.text).not.toContain("\x1b[38;2;");

    // Args complete: the highlight kicks async, invalidates, re-renders.
    const complete = bash.renderCall(
      { command: "git diff --stat" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(plain(complete.text.text)).toContain("$ git diff --stat");
    await waitFor(() => (invalidated.count > 0 ? true : undefined));
    const settled = bash.renderCall(
      { command: "git diff --stat" },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    // Shell grammar colors the command (e.g. the --stat flag or string).
    expect(settled.text.text).toContain("\x1b[38;2;");
    expect(plain(settled.text.text)).toContain("$ git diff --stat");
  });

  it("shows the timeout suffix (SDK parity)", async () => {
    const tools = await registerTools();
    const bash = tools.find((t) => t.name === "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx();
    const component = bash.renderCall(
      { command: "sleep 100", timeout: 30 },
      buildRenderTheme(),
      ctx,
    ) as TextComponent;
    expect(plain(component.text.text)).toContain("(timeout 30s)");
  });
});
