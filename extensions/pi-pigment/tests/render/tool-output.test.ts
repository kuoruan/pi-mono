import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseHitLine } from "#src/render/tool-grep.ts";
import { collapsedView, outputMemoOf, outputTaskKey } from "#src/render/tool-output.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  seedTiming,
  toolOf,
  type DrivenTaskComponent,
  viewFor,
  waitFor,
} from "#test/fixtures.ts";

// The SDK grep/find/ls tools spawn REAL subprocesses (ripgrep/fd) against
// tempdirs — memfs is useless here, the cwd spy + env vars provide the
// isolation instead.
/**
 * Drive a preview-task component's swap protocol to completion: render at
 * the width, wait for the async result to land, return the settled plain
 * text (the grep/find/ls tasks all swap asynchronously).
 *
 * @param component - The task-carrying component (render + text).
 * @param probe - A substring the settled output contains.
 * @returns The settled plain text.
 */
async function settledText(
  component: { render: (width: number) => string[]; text: { text: string } },
  probe: string,
): Promise<string> {
  component.render(120);
  await waitFor(() => (plain(component.text.text).includes(probe) ? true : undefined));
  return plain(component.text.text);
}

describe("output tool wrappers (grep/find/ls/bash/powershell)", () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-pigment-output-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers all seven tools by default", { timeout: 20000 }, async () => {
    const tools = await registerTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "write"]);
  });

  it("every wrapper explicitly claims the default shell (no SDK shell is inherited)", async () => {
    const tools = await registerTools();
    // The factory pins the shell instead of inheriting the SDK origin's
    // (edit declares "self" upstream — an inherited self shell would
    // strip the frame's Box background from our plain-Text renders).
    expect(tools.every((t) => t.renderShell === "default")).toBe(true);
  });

  it("respects disabledTools for the new tools", async () => {
    mkdirSync(join(tempDir, ".pi/extensions/pigment"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi/extensions/pigment/config.jsonc"),
      JSON.stringify({ disabledTools: ["bash", "grep", "ls", "find", "powershell"] }),
    );
    const tools = await registerTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(["edit", "write"]);
  });

  it(
    "grep highlights same-file lines as one block (grammar state flows across lines)",
    { timeout: 20000 },
    async () => {
      // A template literal spanning two lines: the context line ("beta`;")
      // only colors as string content when the grammar state flows from the
      // hit line above it — standalone it tokenizes as an identifier.
      writeFileSync(join(tempDir, "app.ts"), "const s = `alpha\nbeta`;\nconst done = 1;\n");
      const tools = await registerTools();
      const grep = tools.find((t) => t.name === "grep");
      if (!grep?.renderResult) throw new Error("grep not registered");
      const result = await grep.execute(
        "t1",
        { pattern: "done", context: 2 },
        undefined,
        undefined,
        undefined,
      );
      // The theme-selection memos are module-level and registerTools'
      // session_start may have cached a variant under a colliding
      // background key — reset so THIS theme's derivation drives the
      // assertion (beta must carry the string color, which the
      // auto-derived variant computes from this theme's syntax colors).
      // The reset also clears the highlight cache, which is the retry
      // loop's entry point below.
      const fakeTheme = buildFakeTheme({ syntaxColors: true });
      viewFor(fakeTheme);

      // The upstream first-use tokenize fragments under concurrent
      // forks and the wrong output CACHES (docs/open-issues/grammar-
      // state-flake.md). Each attempt re-reads the cache state and
      // rebuilds the component from scratch; a poisoned first render
      // re-tokenizes cleanly once evicted. A corruption that cannot
      // self-heal still fails the existing assertions — a wrong render
      // must never turn into a green one.
      const renderAttempt = async (): Promise<string | undefined> => {
        resetPigmentForTest();
        const { ctx } = makeRenderCtx();
        ctx.args = { pattern: "done" };
        const component = grep.renderResult!(
          result,
          { expanded: true, isPartial: false },
          fakeTheme,
          ctx,
        ) as DrivenTaskComponent;
        // A render frame starts the swap protocol; the async highlight
        // lands eventually — poll for it.
        component.render(120);
        let highlighted = "";
        for (let tries = 0; tries < 100; tries++) {
          highlighted = component.text.text;
          // The AA-enforced string color (the raw syntaxString is
          // lightened for the dark test palette).
          if (highlighted.includes("38;2;224;185;169m")) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const betaLine = highlighted.split("\n").find((l) => plain(l).includes("beta"));
        if (betaLine === undefined) throw new Error("beta line not found in highlighted output");
        // Standalone-tokenize color would mark it an identifier/function
        // (220,220,170) — the per-line rendering the merge replaced. A
        // line carrying it means the upstream fragmentation hit this
        // attempt: report null so the loop clears the cache and retries.
        if (betaLine.includes("38;2;220;220;170m")) return undefined;
        return betaLine;
      };

      let betaLine: string | undefined;
      for (let attempt = 0; attempt < 3 && betaLine === undefined; attempt++) {
        betaLine = await renderAttempt();
      }
      // beta sits INSIDE the template → the string color (AA-enforced
      // form; the raw syntaxString 206,145,120 lightens on the dark
      // canvas).
      expect(betaLine).toContain("38;2;224;185;169m");
      expect(betaLine).not.toContain("38;2;220;220;170m");
    },
  );

  it("grep renders hits with the file:line prefix (placeholder frame; the swap lands async)", async () => {
    writeFileSync(join(tempDir, "app.ts"), "const value = 42;\n");
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult) throw new Error("grep not registered");

    const result = await grep.execute("t1", { pattern: "value" }, undefined, undefined, undefined);
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "value" };
    const component = grep.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    // A render frame drives the swap protocol: the placeholder (plain
    // content) lands synchronously; the async highlight swaps in later.
    component.render(120);
    const text = plain(component.text.text);
    expect(text).toContain("app.ts:1:");
    expect(text).toContain("const value = 42;");
  });

  it("grep's identity carries exactly its documented stamps", async () => {
    writeFileSync(join(tempDir, "identity-stamps.ts"), "const value = 42;\n");
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult) throw new Error("grep not registered");
    const result = await grep.execute("t1", { pattern: "value" }, undefined, undefined, undefined);
    const theme = buildRenderTheme();
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "value" };
    // The duration is part of the key, and it comes from the render-state
    // clock: seed the settled span renderCall marks.
    seedTiming(ctx);
    const component = grep.renderResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      ctx,
    ) as DrivenTaskComponent;
    // The precomputed form: the identity IS outputTaskKey's join. Composing
    // the expectation through the same authorities (the output memo, the
    // palette, the measured duration) keeps it exact — a dropped or
    // reordered stamp fails here.
    const derived = outputMemoOf({})(result as object);
    expect(component.previewIdentity).toBe(
      outputTaskKey({
        prefix: "g",
        derived,
        identity: viewFor(theme).palette.identity,
        elapsedMs: 12,
        expanded: true,
        streaming: false,
      }),
    );
  });

  it("ls renders entries with directories marked", async () => {
    mkdirSync(join(tempDir, "sub"));
    writeFileSync(join(tempDir, "app.ts"), "x\n");
    const tools = await registerTools();
    const ls = tools.find((t) => t.name === "ls");
    if (!ls?.renderResult) throw new Error("ls not registered");

    const result = await ls.execute("t1", { path: tempDir }, undefined, undefined, undefined);
    const { ctx } = makeRenderCtx();
    const component = ls.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    const text = await settledText(component, "app.ts");
    expect(text).toContain("app.ts");
    expect(text).toContain("sub/");
  });

  it("ls renders the SDK's limit notice as a footer, never as a tree row", async () => {
    const tools = await registerTools();
    const ls = tools.find((t) => t.name === "ls");
    if (!ls?.renderResult) throw new Error("ls not registered");
    const { ctx } = makeRenderCtx();
    // A limited listing's real shape: entries then the SDK's notice tail
    // (ls.js appends `\n\n[...]` and sets entryLimitReached). Rendering it
    // as an entry once produced `├── [500 entries limit reached…]]`.
    const component = ls.renderResult(
      {
        content: [
          {
            type: "text",
            text: "app.ts\nnotes.txt\n\n[500 entries limit reached. Use limit=1000 for more]",
          },
        ],
        details: { entryLimitReached: 500 },
      },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    const text = await settledText(component, "app.ts");
    const lines = text.split("\n");
    expect(lines[0]).toContain("app.ts");
    expect(lines[1]).toContain("notes.txt");
    expect(lines[lines.length - 1]).toBe("[500 entries limit reached. Use limit=1000 for more]");
    // The notice is a footer row — exactly one of them, and no tree
    // connector ever prefixes it (the pre-fix bug: `└── [500 entries…]`).
    expect(lines.filter((line) => line.includes("limit reached"))).toEqual([
      "[500 entries limit reached. Use limit=1000 for more]",
    ]);
  });

  it("grep collapses long output with the affordance tail and Took footer", async () => {
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult || !grep.renderCall) throw new Error("grep not registered");
    // 30+ hit lines via a real grep over a generated file.
    const hits = Array.from(
      { length: 30 },
      (_, i) => `export const h${i} = ${i}; // match-target`,
    ).join("\n");
    writeFileSync(join(tempDir, "big.ts"), hits);
    const result = await grep.execute(
      "t1",
      { pattern: "match-target", path: tempDir },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "match-target" };
    seedTiming(ctx);
    const component = grep.renderResult(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    component.render(120); // drive the swap protocol's frame
    const text = plain(component.text.text);
    // Collapsed: the budget's worth of hits, the tail, and the timing.
    expect(text).toContain("match-target");
    expect(text).toContain("more lines, ctrl+o to expand");
    expect(text).toMatch(/Took \d+\.\ds/);
    // And the expanded render drops the affordance tail.
    const expandedComponent = grep.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    expandedComponent.render(120);
    // The expanded re-render swaps in without the collapse affordance.
    await waitFor(() => (plain(expandedComponent.text.text).includes("h29") ? true : undefined));
    expect(plain(expandedComponent.text.text)).not.toContain("more lines");
  });

  it("grep swaps the final frame when the streaming partial shares its length (Took survives)", async () => {
    // The fingerprint key's documented reason to exist: the last streaming
    // partial and the final frame can share a length (the footer-only
    // delta), and a length-only key would leave the stale swap —
    // swallowing the Took footer. Pin the sequence a "simplify the key"
    // refactor must keep passing.
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult || !grep.renderCall) throw new Error("grep not registered");
    const hits = Array.from(
      { length: 30 },
      (_, i) => `export const h${i} = ${i}; // match-target`,
    ).join("\n");
    writeFileSync(join(tempDir, "big.ts"), hits);
    const result = await grep.execute(
      "t1",
      { pattern: "match-target", path: tempDir },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "match-target" };
    // The clock is armed but not settled — the partial frame's state
    // (seedTiming would settle the span; a live arm starts at the clock).
    ctx.state.startedAt = Date.now();
    // Streaming partial: same output text (hence same length), but the
    // clock is still running (isPartial) — no duration in the key yet.
    const partial = grep.renderResult(
      result,
      { expanded: false, isPartial: true },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    partial.render(120);
    const partialText = plain(partial.text.text);
    expect(partialText).toContain("more lines");
    expect(partialText).not.toMatch(/Took /);
    // Final frame: identical length, isPartial flips false — the key must
    // change anyway and land the footer.
    const finalC = grep.renderResult(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    finalC.render(120);
    await waitFor(() => (/Took \d+\.\ds/.test(plain(finalC.text.text)) ? true : undefined));
    expect(plain(finalC.text.text)).toMatch(/Took \d+\.\ds/);
  });

  it("grep re-renders when the theme identity changes (the key carries the palette)", async () => {
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult || !grep.renderCall) throw new Error("grep not registered");
    writeFileSync(join(tempDir, "theme.ts"), "export const k = 1; // match-target\n");
    const result = await grep.execute(
      "t1",
      { pattern: "match-target", path: tempDir },
      undefined,
      undefined,
      undefined,
    );
    const { ctx, invalidated } = makeRenderCtx();
    ctx.args = { pattern: "match-target" };
    const themeA = buildRenderTheme();
    const cA = grep.renderResult(
      result,
      { expanded: false, isPartial: false },
      themeA,
      ctx,
    ) as DrivenTaskComponent;
    cA.render(120);
    await waitFor(() => (plain(cA.text.text).includes("match-target") ? true : undefined));
    const swapsAfterA = invalidated.count;
    // Same content, same expand state, NEW theme object — the key must
    // differ and drive a fresh render (stale colors otherwise persist
    // until the content changes).
    const themeB = buildRenderTheme();
    const cB = grep.renderResult(
      result,
      { expanded: false, isPartial: false },
      themeB,
      ctx,
    ) as DrivenTaskComponent;
    cB.render(120);
    await waitFor(() =>
      plain(cB.text.text).includes("match-target") && invalidated.count > swapsAfterA
        ? true
        : undefined,
    );
    expect(invalidated.count).toBeGreaterThan(swapsAfterA);
  });

  it("find collapses long result lists with the affordance tail", async () => {
    const tools = await registerTools();
    const find = tools.find((t) => t.name === "find");
    if (!find?.renderResult) throw new Error("find not registered");
    for (let i = 0; i < 30; i++) writeFileSync(join(tempDir, `f${i}.ts`), "x\n");
    const result = await find.execute(
      "t1",
      { pattern: "*.ts", path: tempDir },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    seedTiming(ctx);
    const component = find.renderResult(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    const text = await settledText(component, "f0.ts");
    expect(text).toContain("more lines, ctrl+o to expand");
    expect(text).toMatch(/Took \d+\.\ds/);
  });

  it("ls renders a tree with connectors, collapse, and Took", async () => {
    mkdirSync(join(tempDir, "sub"));
    writeFileSync(join(tempDir, "app.ts"), "x\n");
    for (let i = 0; i < 25; i++) writeFileSync(join(tempDir, `f${i}.ts`), "x\n");
    const tools = await registerTools();
    const ls = tools.find((t) => t.name === "ls");
    if (!ls?.renderResult) throw new Error("ls not registered");
    const result = await ls.execute("t1", { path: tempDir }, undefined, undefined, undefined);
    const { ctx } = makeRenderCtx();
    seedTiming(ctx);
    const collapsed = ls.renderResult(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    const collapsedText = await settledText(collapsed, "├── ");
    expect(collapsedText).toContain("├── ");
    expect(collapsedText).toContain("more lines, ctrl+o to expand");
    expect(collapsedText).toMatch(/Took \d+\.\ds/);

    const expanded = ls.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    const expandedText = await settledText(expanded, "└── ");
    expect(expandedText).toContain("└── "); // the elbow on the last entry
    expect(expandedText).not.toContain("more lines");
  });

  it("Took comes from the render-state clock: a live row has one, a resumed row does not", async () => {
    writeFileSync(join(tempDir, "app.ts"), "x\n");
    const tools = await registerTools();
    const ls = toolOf(tools, "ls");
    const result = await ls.execute("t-live", { path: tempDir }, undefined, undefined, undefined);
    const theme = buildRenderTheme();
    const options = { expanded: false, isPartial: false };

    // LIVE: the TUI renders the call while the execution runs
    // (executionStarted), which arms the clock; the settled result stops it.
    const live = makeRenderCtx();
    live.ctx.toolCallId = "t-live";
    live.ctx.args = { path: tempDir };
    live.ctx.executionStarted = true;
    ls.renderCall!({ path: tempDir }, theme, live.ctx);
    const liveFrame = ls.renderResult!(result, options, theme, live.ctx) as DrivenTaskComponent;
    expect(await settledText(liveFrame, "── ")).toMatch(/Took \d+\.\ds/);

    // RESUME: pi replays the row with executionStarted false and never
    // re-arms — no duration, and nothing about the timing was persisted to
    // recover it from. This is pi's own renderer behavior (its startedAt
    // lives in the same render state).
    const resumed = makeRenderCtx();
    resumed.ctx.toolCallId = "t-live";
    resumed.ctx.args = { path: tempDir };
    ls.renderCall!({ path: tempDir }, theme, resumed.ctx);
    expect(resumed.ctx.executionStarted).toBe(false);
    const resumedFrame = ls.renderResult!(
      result,
      options,
      theme,
      resumed.ctx,
    ) as DrivenTaskComponent;
    const resumedText = await settledText(resumedFrame, "── ");
    expect(resumedText).toContain("── ");
    expect(resumedText).not.toMatch(/Took/);
  });

  it("ls rows never emit a full SGR reset and the Took footer sits a blank line below the tree", async () => {
    mkdirSync(join(tempDir, "sub"));
    writeFileSync(join(tempDir, "app.ts"), "x\n");
    writeFileSync(join(tempDir, "notes.txt"), "x\n");
    const tools = await registerTools();
    const ls = tools.find((t) => t.name === "ls");
    if (!ls?.renderResult) throw new Error("ls not registered");
    const result = await ls.execute("t1", { path: tempDir }, undefined, undefined, undefined);
    const { ctx } = makeRenderCtx();
    seedTiming(ctx);
    // pi's real Theme closes fg/bg wrappers with channel-scoped resets
    // (\x1b[39m / \x1b[49m); pi core then wraps every result line with
    // its canvas bg (toolSuccessBg). Therefore extension output must
    // never emit a FULL \x1b[0m: it kills the canvas mid-row and the
    // row's tail falls back to the terminal's default background.
    const piLikeTheme = {
      name: "pi-like",
      fg: (name: string, text: string) =>
        `\x1b[38;2;${name === "muted" ? "108;108;108" : "90;128;128"}m${text}\x1b[39m`,
      bg: (_name: string, text: string) => text,
      getFgAnsi: () => "",
      getBgAnsi: () => "",
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    };
    const component = ls.renderResult(
      result,
      { expanded: true, isPartial: false },
      piLikeTheme,
      ctx,
    ) as DrivenTaskComponent;
    await settledText(component, "└── ");
    const raw = component.text.text;
    expect(raw).toContain("app.ts"); // exercise a code-file (fgCode) row
    expect(raw).not.toContain("\x1b[0m"); // regression: full reset whitens the row tail
    expect(plain(raw)).toMatch(/└── [^\n]*\n\nTook \d+\.\ds/);
  });

  it("bash delegates execution verbatim (streaming updates included)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash) throw new Error("bash not registered");
    const snaps: string[] = [];
    const result = await bash.execute(
      "t1",
      { command: "for i in 1 2; do echo l$i; sleep 0.05; done" },
      undefined,
      (u: { content?: Array<{ text?: string }> }) => {
        if (u?.content?.[0]?.text) snaps.push(u.content[0].text);
      },
      undefined,
    );
    expect(snaps.length).toBeGreaterThanOrEqual(1); // streaming snapshots flowed
    expect(plain((result.content?.[0] as { text?: string } | undefined)?.text ?? "")).toContain(
      "l1",
    );
    expect(plain((result.content?.[0] as { text?: string } | undefined)?.text ?? "")).toContain(
      "l2",
    );
  });
});

describe("the window authority (collapsedView)", () => {
  it("collapses to the budget with the expand affordance", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
    const { shown, tail } = collapsedView(lines, {
      budget: 15,
      expanded: false,
      theme: buildRenderTheme(),
    });
    expect(shown.length).toBe(15);
    expect(tail).toContain("15 more lines");
    expect(tail).toContain("ctrl+o to expand");
  });

  it("expands to everything when no cap is set (grep/find/ls)", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
    const { shown, tail } = collapsedView(lines, {
      budget: 15,
      expanded: true,
      theme: buildRenderTheme(),
    });
    expect(shown.length).toBe(30);
    expect(tail).toBe("");
  });

  it("caps the expanded regime and reports without the affordance (write's preview)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `L${i}`);
    const { shown, tail } = collapsedView(lines, {
      budget: 10,
      expanded: true,
      expandedCap: 150,
      theme: buildRenderTheme(),
    });
    expect(shown.length).toBe(150);
    expect(tail).toContain("50 more lines");
    expect(tail).not.toContain("ctrl+o");
  });

  it("paints the limit notice as a footer line, outside the window and its budget", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
    const notice = "[50.0KB limit reached]";
    const { shown, tail } = collapsedView(lines, {
      budget: 15,
      expanded: false,
      notice,
      theme: buildRenderTheme(),
    });
    // The notice is not a body line: the window still shows the full budget.
    expect(shown.length).toBe(15);
    expect(shown).not.toContain(notice);
    expect(tail.split("\n")).toEqual(["... (15 more lines, ctrl+o to expand)", notice]);
  });
});

describe("the limit notice (the SDK's details, not the text shape)", () => {
  const derive = outputMemoOf({});
  const limited = (text: string, details: unknown) =>
    derive({ content: [{ type: "text", text }], details });

  it("lifts the SDK's trailing notice out of the body when details flags a limit", () => {
    const derived = limited("a.ts\nb.ts\n\n[1000 results limit reached]", {
      resultLimitReached: 1000,
    });
    // Lift from BOTH views (grep's line budget and find/ls's entry list),
    // separator blank included: the notice can never render as a hit, a
    // path, or a tree row.
    expect(derived.lines).toEqual(["a.ts", "b.ts"]);
    expect(derived.entries).toEqual(["a.ts", "b.ts"]);
    expect(derived.notice).toBe("[1000 results limit reached]");
  });

  it("reads every flag the SDK's renderers read (grep's three, find/ls's cap, truncation)", () => {
    const text = "hit.txt:12: x\n\n[50.0KB limit reached]";
    for (const details of [
      { matchLimitReached: 200 },
      { linesTruncated: true },
      { truncation: { truncated: true } },
      { resultLimitReached: 500 },
      { entryLimitReached: 500 },
    ]) {
      expect(limited(text, details).notice).toBe("[50.0KB limit reached]");
    }
  });

  it("keeps a bracketed line in the body without details (a filename is not a notice)", () => {
    const derived = limited("[note].md\nsrc/index.ts", undefined);
    expect(derived.entries).toEqual(["[note].md", "src/index.ts"]);
    expect(derived.notice).toBe("");
  });

  it("keeps a notice-only body intact (nothing else carries the output)", () => {
    const derived = limited("[50.0KB limit reached]", { truncation: { truncated: true } });
    expect(derived.entries).toEqual(["[50.0KB limit reached]"]);
    expect(derived.notice).toBe("");
  });
});

describe("grep context-line parsing", () => {
  it("anchors the separator after path-shaped prefixes containing -N-", () => {
    const out = "issue-123-fix.ts-12- const value = 1;\nplain-3- ctx line here"
      .split("\n")
      .map((line) => parseHitLine(line));
    // The path keeps its full name; language detection lands on .ts.
    expect(out[0]).toEqual({
      prefix: "issue-123-fix.ts-12-",
      content: "const value = 1;",
      isContext: true,
    });
    // A path-less candidate falls back to the first separator.
    expect(out[1]).toEqual({
      prefix: "plain-3-",
      content: "ctx line here",
      isContext: true,
    });
  });

  it("prefers the first path-shaped separator when content also has -N-", () => {
    const out = ["notes.md-3- see issue-5- notes"].map((line) => parseHitLine(line));
    expect(out[0]).toEqual({
      prefix: "notes.md-3-",
      content: "see issue-5- notes",
      isContext: true,
    });
  });
});
