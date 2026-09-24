import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilityOverrides, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createShellWrapper } from "#src/render/shell-tool.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  type DrivenTaskComponent,
  type RenderCallCarrier,
  makeRenderCtx,
  type TaskCarrier,
  type TextComponent,
  makeRenderSession,
  plain,
  registerTools,
  toolOf,
} from "#test/fixtures.ts";

describe("bash header ellipsis", () => {
  it("collapses a long command to the middle-cut shape with the suffix pinned", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    ctx.args = {
      command: `git checkout --track origin/${"very-long-branch-name-".repeat(6)}`,
    };
    const component = bash.renderCall!(ctx.args, buildRenderTheme(), ctx);
    // Drive the width-aware path at 40 columns, then settle the async
    // render (the placeholder uses the ambient terminal width).
    component.render(40);
    await vi.waitFor(() => {
      const line = plain(component.text.text).split("\n")[0];
      if (!line.includes("…")) throw new Error("waiting for ellipsis frame");
    });
    const line = plain(component.text.text).split("\n")[0];
    expect(line).toContain("…");
    expect(line.startsWith("$ git")).toBe(true);
    // The tail survives ahead of the pinned suffix (the suffix, not the
    // tail, owns the line end).
    expect(line).toContain("branch-name-");
    expect(line.endsWith("· ✓")).toBe(true);
  });

  it("renders the full line when expanded", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    const command = `git checkout --track origin/${"very-long-branch-name-".repeat(6)}`;
    ctx.args = { command };
    ctx.expanded = true;
    const component = bash.renderCall!(ctx.args, buildRenderTheme(), ctx);
    const rows = component.render(40);
    expect(plain(rows.join("\n"))).toContain(command);
  });

  it("renders the full line with no task when the switch is off", () => {
    const bash = createShellWrapper(
      createBashToolDefinition(process.cwd()) as never,
      {
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        headerEllipsis: "off",
        textFactory: Text,
        render: makeRenderSession(),
      },
      { language: "shellscript", prompt: "$" },
    ) as unknown as {
      renderCall: (args: unknown, theme: unknown, ctx: unknown) => TextComponent & TaskCarrier;
    };
    const { ctx } = makeRenderCtx();
    const command = `git checkout --track origin/${"very-long-branch-name-".repeat(6)}`;
    ctx.args = { command };
    const component = bash.renderCall(ctx.args, buildRenderTheme(), ctx);
    expect(component.previewTask).toBe(undefined);
    expect(plain(component.text.text)).toContain(command);
  });
});

describe("powershell header ellipsis (parity)", () => {
  it("collapses a long command like bash", async () => {
    const tools = await registerTools();
    const pwsh = toolOf(tools, "powershell");
    const { ctx } = makeRenderCtx();
    ctx.args = { command: `Get-ChildItem ${"very-long-directory-name-".repeat(6)}` };
    const component = pwsh.renderCall!(
      ctx.args,
      buildRenderTheme(),
      ctx,
    ) as unknown as DrivenTaskComponent;
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("…")) throw new Error("waiting");
    });
    expect(plain(component.text.text)).toContain("…");
  });
});

describe("grep/find/ls header ellipsis", () => {
  const cases: Array<{ tool: string; args: Record<string, string> }> = [
    { tool: "grep", args: { pattern: `needle-${"x".repeat(120)}`, path: "/project" } },
    { tool: "find", args: { pattern: `name-${"y".repeat(120)}`, path: "/project" } },
    { tool: "ls", args: { path: `/${"deep-".repeat(30)}dir` } },
  ];
  for (const { tool, args } of cases) {
    it(`${tool} collapses a long header and keeps its trailing blank`, async () => {
      const tools = await registerTools();
      const t = toolOf(tools, tool);
      const { ctx } = makeRenderCtx();
      ctx.args = args;
      const component = t.renderCall!(
        ctx.args,
        buildRenderTheme(),
        ctx,
      ) as unknown as DrivenTaskComponent;
      component.render(40);
      await vi.waitFor(() => {
        if (!plain(component.text.text).includes("…")) throw new Error("waiting");
      });
      const text = plain(component.text.text);
      expect(text).toContain("…");
      expect(text.endsWith("\n")).toBe(true);
    });
  }
});

describe("header trailing blank follows call state", () => {
  it("re-arms the task on pending→error so the separator blank lands", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/project/app.ts", edits: [] };
    // Streaming: the pending header owns no trailing blank.
    ctx.isPartial = true;
    const component = edit.renderCall!(
      ctx.args,
      buildRenderTheme(),
      ctx,
    ) as unknown as DrivenTaskComponent;
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("← edit")) throw new Error("waiting");
    });
    expect(plain(component.text.text).endsWith("\n")).toBe(false);
    // Settled on the same host: the task must re-arm for the blank.
    ctx.isPartial = false;
    ctx.isError = true;
    ctx.lastComponent = component as never;
    edit.renderCall!(ctx.args, buildRenderTheme(), ctx);
    component.render(120);
    await vi.waitFor(() => {
      if (!plain(component.text.text).endsWith("\n")) throw new Error("waiting");
    });
  });
});

describe("write/edit header ellipsis (stats chips pinned)", () => {
  it("edit keeps the +N -M chip outside the ellipsis budget", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    const { ctx } = makeRenderCtx();
    ctx.args = { path: `/project/${"deep-".repeat(30)}file.ts`, edits: [] };
    const component = edit.renderCall!(
      ctx.args,
      buildRenderTheme(),
      ctx,
    ) as unknown as DrivenTaskComponent;
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("…")) throw new Error("waiting");
    });
    expect(plain(component.text.text)).toContain("…");
  });

  it("clears the task when toggled off (no stale ellipsis frame)", () => {
    const on = createShellWrapper(
      createBashToolDefinition(process.cwd()) as never,
      {
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        headerEllipsis: "on",
        textFactory: Text,
        render: makeRenderSession(),
      },
      { language: "shellscript", prompt: "$" },
    ) as unknown as RenderCallCarrier;
    const { ctx } = makeRenderCtx();
    const command = `git checkout --track origin/${"very-long-branch-name-".repeat(6)}`;
    ctx.args = { command };
    const first = on.renderCall(ctx.args, buildRenderTheme(), ctx);
    expect(first.previewTask).not.toBe(undefined);
    // Same host, switch off: the stale task must clear, setText wins.
    const off = createShellWrapper(
      createBashToolDefinition(process.cwd()) as never,
      {
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        headerEllipsis: "off",
        textFactory: Text,
        render: makeRenderSession(),
      },
      { language: "shellscript", prompt: "$" },
    ) as unknown as RenderCallCarrier;
    const host = first as unknown as TextComponent & TaskCarrier;
    const second = off.renderCall(ctx.args, buildRenderTheme(), {
      ...ctx,
      lastComponent: host,
    });
    expect(second.previewTask).toBe(undefined);
    expect(plain(second.text.text)).toContain(command);
  });
});

describe("header ellipsis toggle", () => {
  it("refits to full on expand and back on collapse", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const command = `git checkout --track origin/${"very-long-branch-name-".repeat(6)}`;
    const { ctx } = makeRenderCtx();
    ctx.args = { command };
    const render = (): DrivenTaskComponent =>
      bash.renderCall!(ctx.args, buildRenderTheme(), ctx) as unknown as DrivenTaskComponent;
    // Collapsed: ellipsis.
    let component = render();
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("…")) throw new Error("waiting");
    });
    // Expanded: the same width renders full (stamps carry the bit, so
    // the task re-arms and refits).
    ctx.expanded = true;
    component = render();
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes(command)) throw new Error("waiting");
    });
    expect(plain(component.text.text)).not.toContain("…");
  });

  it("re-arms on the REUSED host (the stamp-driven path, not a fresh mount)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const command = `git checkout --track origin/${"very-long-branch-name-".repeat(6)}`;
    const { ctx } = makeRenderCtx();
    ctx.args = { command };
    // One component, rendered twice — the TUI reuses the host across
    // updateDisplay cycles, so the second attach must see the changed
    // expanded stamp and re-arm (a fresh host would attach unconditionally
    // and prove nothing).
    const component = bash.renderCall!(
      ctx.args,
      buildRenderTheme(),
      ctx,
    ) as unknown as DrivenTaskComponent;
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("…")) throw new Error("waiting");
    });
    ctx.expanded = true;
    bash.renderCall!(ctx.args, buildRenderTheme(), ctx);
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes(command)) throw new Error("waiting");
    });
    expect(plain(component.text.text)).not.toContain("…");
  });
});

describe("header marks styling", () => {
  it("carries the muted slot on the ellipsis and fold marks", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    // A heredoc: the newline becomes the fold mark, the width forces the cut.
    ctx.args = {
      command: `python3 - <<'EOF'\n${"print(very_long_line) # comment\n".repeat(8)}EOF`,
    };
    const theme = buildFakeTheme();
    const component = bash.renderCall!(ctx.args, theme, ctx) as unknown as DrivenTaskComponent;
    component.render(40);
    await vi.waitFor(() => {
      if (!plain(component.text.text).includes("…")) throw new Error("waiting");
    });
    const raw = component.text.text;
    const muted = theme.getFgAnsi("muted");
    expect(raw).toContain(`${muted}…`);
    expect(raw).toContain(`${muted}⏎`);
  });
});

describe("ls header link target", () => {
  it("resolves the URL from the raw arg, not the shortened display", async () => {
    // The harness reports incapable; flip it per-test (the API exists
    // for exactly this — no module mock needed).
    setCapabilityOverrides({ hyperlinks: true });
    try {
      const tools = await registerTools();
      const t = toolOf(tools, "ls");
      const { ctx } = makeRenderCtx();
      // HOME always exists in the test env; the path must sit under it
      // so the display shortens to ~/proj while the URL stays absolute.
      const home = process.env.HOME as string;
      // Both spellings must land on the same target: node resolve()
      // does not expand `~`, but the SDK's resolvePath does (and the
      // tool resolves it at execution).
      for (const arg of [`${home}/proj`, "~/proj"]) {
        ctx.args = { path: arg };
        const component = t.renderCall!(
          ctx.args,
          buildRenderTheme(),
          ctx,
        ) as unknown as DrivenTaskComponent;
        component.render(120);
        const raw = component.text.text;
        // Display shortens to ~/proj, but the link target must be the
        // real location — never <cwd>/~/proj.
        expect(raw).toContain("~/proj");
        expect(raw).not.toContain("/~/");
        expect(raw).toContain(`${home}/proj`);
      }
    } finally {
      resetCapabilitiesCache();
    }
  });
});
