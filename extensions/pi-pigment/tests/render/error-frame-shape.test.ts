/**
 * THE error-frame shape suite: every tool's failure render, asserted
 * LINE BY LINE through the ToolDefinition interface (renderResult with
 * ctx.isError) — the seam the TUI itself drives. The contract under
 * test, per tool:
 *
 * - Edit/write/grep/find/ls: the CALL header above already names the tool — the error body renders
 *   alone (bar rows + optional Took, nothing else; no second header row).
 * - Bash/powershell: the call header is the command echo, so it carries the failure badge as its
 *   suffix ("✗ exit 1" — see bash-call-shape.test.ts); a RECOGNIZED status line renders body-only
 *   here too, and the frame's own name header remains only for an unrecognized shell failure.
 *
 * All assertions are on plain(rendered) — the final setText text, SGR
 * stripped — so a row's exact leading whitespace (the bar column, the
 * content column) is part of the pinned shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isBenignExit, shellBadgeText, shellExitBadgeOf } from "#src/render/error-frame.ts";
import type { PreviewTextHost } from "#src/render/text-task.ts";
import type { ShellState } from "#src/render/tool-services.ts";
import type { PaletteTheme } from "#src/theme/palette.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  seedTiming,
  toolOf,
  type TextDouble,
} from "#test/fixtures.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

/**
 * The frame's rows, plain-text, with the trailing pad row dropped.
 *
 * @param component - The rendered component (its setText text is the
 *   frame's final shape).
 * @returns The frame's plain rows.
 */
function rowsOf(component: unknown): string[] {
  const text = (component as TextDouble).text.text;
  return plain(text).split("\n");
}

beforeEach(() => {
  resetPigmentForTest();
  vol.reset();
  vol.mkdirSync("/render-project", { recursive: true });
  process.env.PI_CODING_AGENT_DIR = "/render-agent";
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  vol.reset();
});

describe("edit error frame shape", () => {
  it("never repeats the call header on validation failures (args empty, no path)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = {}; // the call failed ARG validation — no path, no edits

    const component = edit.renderResult!(
      {
        content: [
          {
            type: "text",
            text: 'Validation failed for tool "edit":\n- path: must have required properties path',
          },
        ],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    // Header ownership is decided by the TOOL KIND, not by the path's
    // presence — the call header above still shows the bare "← edit",
    // so the error frame must NOT add a second "← edit" row.
    expect(rows.filter((r) => /^\s*(← )?edit\b/.test(r))).toEqual([]);
    // Body-only: the call header's trailing blank is the separator — the
    // body opens on the bar row.
    expect(rows[0]).not.toBe("");
    expect(rows.some((r) => r.startsWith("▌ Validation failed"))).toBe(true);
  });

  it("flips the renderCall header's background to the error tint on failed calls", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    const theme = buildRenderTheme();

    // Live call: the header Text's custom bg = the palette's base tint.
    const live = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      theme,
      ctx,
    ) as PreviewTextHost;
    expect(typeof live.customBgFn).toBe("function");
    const liveBg = live.customBgFn!("row");
    expect(liveBg).toContain("48;2;30;30;40"); // toolSuccessBg in the fake theme's palette

    // Failed call: isError flips the header to the ERROR tint so the
    // header row matches the all-error frame below it (the default
    // shell's Box paints error bg too, but the Text's own bg composes
    // OVER the Box bg on its rows — without the flip the header row
    // would keep its success tint inside an otherwise red frame).
    ctx.isError = true;
    const failed = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      theme,
      ctx,
    ) as PreviewTextHost;
    const errorBg = failed.customBgFn!("row");
    expect(errorBg).toContain("48;2;40;30;30"); // the fake theme's error bg
  });

  it("an error row's tail continues the ERROR bg (no success-canvas stripe at the frame edge)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    const failed = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      buildRenderTheme(),
      ctx,
    ) as PreviewTextHost;
    // The row-end continuation must re-open the ERROR bg — the diff-row
    // rowReset (bgBase = the success canvas, 30;30;40 in the fake) would
    // paint the box padding cells green behind an all-error frame.
    const errorBg = failed.customBgFn!("row");
    expect(errorBg).not.toContain("48;2;30;30;40");
    expect(errorBg).toContain("48;2;40;30;30");
  });

  it("a success row's tail continues the SUCCESS bg (no bare-reset tail)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    const ok = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      buildRenderTheme(),
      ctx,
    ) as PreviewTextHost;
    // The row-end continuation must re-open the SUCCESS bg — a bare
    // RESET tail would drop the box padding cells to the terminal
    // default behind a success header (the error twin above pins the
    // mirror case).
    const successRow = ok.customBgFn!("row");
    expect(successRow.endsWith("\x1b[48;2;30;30;40m")).toBe(true);
    expect(successRow).not.toContain("48;2;40;30;30");
  });

  it("keeps the renderCall header transparent while the call streams (no success-tint leak)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.isPartial = true; // streaming: the edit has not executed yet
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    const theme = buildRenderTheme();

    // A pending frame must carry no success tint: the header's custom bg
    // is cleared, so the default shell's pending Box bg shows through.
    const live = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      theme,
      ctx,
    ) as PreviewTextHost;
    expect(live.customBgFn).toBeUndefined();
  });

  it("a pending call header renders with no trailing blank (the frame padding supplies the one)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.isPartial = true;
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    const live = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      buildRenderTheme(),
      ctx,
    );
    // Streaming frames carry ONLY the header row: the header's own
    // separator blank would stack on the default shell's bottom padding
    // and double the gap (the two-blank pending frame this pins).
    const rows = rowsOf(live);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("← edit");
  });

  it("a settled call header keeps its single separator blank row", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    const live = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(live);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("");
  });

  it("paints a succeeded header with the theme's RAW success slot (not the derived canvas)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderCall) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    // A 256-color success slot: the palette cannot parse it and would
    // derive a neutral canvas — the header must still paint the slot the
    // TUI's frame Box paints, so the row matches the frame.
    const theme: PaletteTheme = {
      bold: (text) => text,
      fg: (_name, text) => text,
      getFgAnsi: () => "",
      getBgAnsi: (name) => (name === "toolSuccessBg" ? "\u001b[48;5;123m" : "\u001b[48;5;9m"),
      bg: (_name, text) => text,
    };
    const live = edit.renderCall(
      { path: "/render-project/app.ts", edits: [] },
      theme,
      ctx,
    ) as PreviewTextHost;
    expect(live.customBgFn!("row")).toContain("48;5;123");
  });

  it("the error frame sweeps any streaming interval off the render state", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderResult) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    ctx.isError = true;
    // A shell-style interval handle left on the state by a bypassed
    // native renderer — the factory's error path must clear it
    // regardless of the tool (edit has no onError of its own).
    ctx.state.interval = { handle: 1 } as unknown as ReturnType<typeof setInterval>;
    edit.renderResult!(
      { content: [{ type: "text", text: "boom" }], isError: true } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(ctx.state.interval).toBeUndefined();
  });

  it("a succeeded final render sweeps a streaming interval too (not only the error path)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    if (!edit?.renderResult) throw new Error("edit not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    // Every FINAL frame (success included) must extinguish the streaming
    // interval — the SDK's own renderer clears it on the frames it runs,
    // but a success path that does NOT delegate (this edit wrapper
    // replaces the renderer outright) would otherwise leak it.
    ctx.state.interval = { handle: 1 } as unknown as ReturnType<typeof setInterval>;
    edit.renderResult!(
      {
        content: [{ type: "text", text: 'Successfully edited "app.ts"' }],
        details: {},
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(ctx.state.interval).toBeUndefined();
  });

  it("does not repeat the call header — the body opens with the separator blank, then the bar row", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/app.ts", edits: [] };

    const component = edit.renderResult!(
      {
        content: [
          {
            type: "text",
            text: "Could not find the exact text in /render-project/app.ts. The old text must match exactly.",
          },
        ],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );

    const rows = rowsOf(component);
    // ONE header at most: no row may LEAD with the tool name + path the
    // call header above already shows (the message text may legitimately
    // contain the path — the header shape is `name path…` at a row's
    // start).
    const headerRows = rows.filter((r) => /^\s*(← )?edit\b/.test(r));
    expect(headerRows).toEqual([]);
    // Body-only: the call header's own trailing blank is the separator —
    // the body starts on the bar row (bar flush at column 0, content
    // one space after), not a second blank.
    expect(rows[0]).not.toBe("");
    expect(rows.some((r) => r.startsWith("▌ Could not find the exact text"))).toBe(true);
  });

  it("keeps a blank row between the body and the Took row (the native frame's composition)", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    // The Took source is the render-state clock (armed by renderCall,
    // stopped by the settled frame), never the result's details.
    seedTiming(ctx, 42);

    const component = edit.renderResult!(
      {
        content: [{ type: "text", text: "nope" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    const tookIndex = rows.findIndex((r) => r.trim().startsWith("Took"));
    expect(tookIndex).toBeGreaterThan(-1);
    // The blank row between body and Took — the native renderer's own
    // composition (its Took child Text starts on a fresh empty row).
    expect(rows[tookIndex - 1]?.trim()).toBe("");
    expect(rows[tookIndex]).toMatch(/^Took /);
    // And when NO timing is known, there is no Took row at all: the
    // shape is exactly the bar body.
    const { ctx: noTookCtx } = makeRenderCtx();
    noTookCtx.isError = true;
    noTookCtx.toolCallId = "no-took-call";
    noTookCtx.args = { path: "/render-project/app.ts", edits: [] };
    const bare = edit.renderResult!(
      {
        content: [{ type: "text", text: "nope" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      noTookCtx,
    );
    expect(rowsOf(bare).filter((r) => r.trim() !== "" && !r.startsWith("▌"))).toEqual([]);
  });
});

describe("write error frame shape", () => {
  it("does not repeat the call header", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/new.ts", content: "x" };

    const component = write.renderResult!(
      {
        content: [{ type: "text", text: "Failed to write file" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    // No header row: nothing that names the tool at a row's start (the
    // message text itself may mention "write" — the header shape is
    // `name path…`, a row LEADING with the name).
    expect(rows.filter((r) => /^\s*(← )?(write|create)\b/.test(r))).toEqual([]);
    // Body-only: the call header's trailing blank is the separator.
    expect(rows[0]).not.toBe("");
    expect(rows.some((r) => r.startsWith("▌ Failed to write file"))).toBe(true);
  });

  it("flips the call header to the error background once the call errors (the aborted-create row)", async () => {
    const tools = await registerTools();
    const write = toolOf(tools, "write");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/new.ts", content: "x" };
    // The error render lands first (the factory's error branch paints the
    // whole component's error bg); a later updateDisplay re-runs the CALL
    // render, and the header row must follow the outcome instead of
    // repainting the success tint over an all-error frame (the
    // aborted-create call that showed a white " ← create" row).
    write.renderResult!(
      {
        content: [{ type: "text", text: "Operation aborted" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const header = write.renderCall!(
      { path: "/render-project/new.ts", content: "x" },
      buildRenderTheme(),
      ctx,
    );
    const painted = header.customBgFn?.("← create x") ?? "";
    // The line OPENS with the theme's ERROR bg (48;2;40;30;30 — not the
    // success tint 48;2;30;30;40 the pre-fix renderCall always
    // reapplied); the palette's rowReset tail re-opens bgBase by design.
    expect(painted.startsWith("\x1b[48;2;40;30;30m")).toBe(true);
  });
});

describe("bash error frame shape", () => {
  it("bars every VISUAL row when a message line wraps at the render width", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { command: "false" };
    seedTiming(ctx, 5);
    // One long logical line: the TUI wraps it into several visual rows —
    // the bar column must lead EVERY one, not just the first.
    const message = `${"X".repeat(90)}\n\nCommand exited with code 1`;

    const component = bash.renderResult!(
      {
        content: [{ type: "text", text: message }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as unknown as PreviewTextHost;
    const rendered = await component.previewTask!.render(60);
    const xRows = plain(rendered)
      .split("\n")
      .filter((r) => r.includes("XXX"));
    // Two visual rows (wrapped at 60) — BOTH carry the bar.
    expect(xRows.length).toBe(2);
    expect(xRows.every((r) => r.startsWith("▌ "))).toBe(true);
  });

  it("breaks prose at word boundaries — no mid-word split at the wrap edge", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { command: "false" };
    // "exactly" sits across the 75-column wrap edge — a column wrap
    // splits it mid-word and DROPS characters at the boundary.
    const message = `Could not find the exact text in /tmp/pette/tt.ts. The old text must match exactly including all whitespace and newlines.\n\nCommand exited with code 1`;

    const component = bash.renderResult!(
      {
        content: [{ type: "text", text: message }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as unknown as PreviewTextHost;
    const rows = plain(await component.previewTask!.render(72)).split("\n");
    // The break lands on the space BEFORE "match": the first visual row
    // ends at the word boundary "must", the continuation starts with the
    // whole word "match" — never a mid-word fragment ("xactly").
    expect(rows.some((r) => r.startsWith("▌ xactly") || r.startsWith("xactly"))).toBe(false);
    expect(rows.some((r) => r.trimEnd().endsWith("must"))).toBe(true);
    expect(rows.some((r) => r.startsWith("▌ match exactly"))).toBe(true);
  });

  it("stays headless when the status line parses — the badge rides the call header", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { command: "false" };

    const component = bash.renderResult!(
      {
        content: [
          {
            type: "text",
            text: "\n\nCommand exited with code 1",
          },
        ],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    // NO name header: the call header above (the command echo) carries the
    // "✗ exit 1" badge inline — a second header would say it twice.
    expect(rows.filter((r) => r.includes("bash"))).toEqual([]);
    // Body-only: the frame's first row is the separator blank (the pad
    // the old standalone header's bottomPad used to leave); the blank
    // bar rows for the message's own leading blank lines follow (the
    // appendStatus separator's shape, rendered as-is).
    expect(rows[0]).toBe("");
    expect(rows.some((r) => r.startsWith("▌ Command exited with code 1"))).toBe(true);
  });

  it("treats the terminated status line as a recognized badge (headless too)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { command: "yes | head -c 1" };

    const component = bash.renderResult!(
      {
        content: [{ type: "text", text: "\n\nCommand terminated without an exit code" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    expect(rows.filter((r) => r.includes("bash"))).toEqual([]);
    expect(rows[0]).toBe("");
    expect(rows.some((r) => r.startsWith("▌ Command terminated without an exit code"))).toBe(true);
  });

  it("keeps its name header when the tail parses to no badge (the degraded case)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { command: "false" };

    const component = bash.renderResult!(
      {
        content: [{ type: "text", text: "spawn bash failed: no such file" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    // The unrecognized failure still names its tool — degraded, not broken.
    expect(rows[0]).toBe("bash");
    expect(rows.some((r) => r.startsWith("▌ spawn bash failed"))).toBe(true);
  });
});

describe("the error frame's Took color follows the failure kind", () => {
  // The footer color is the frame's bar kind (one failure-kind reading):
  // a plain exit renders error, the code-less kinds (timeout, signal,
  // aborted, terminated) warn, and a non-shell frame — no badge to
  // refine the kind — renders error too.
  it("bash: exit-1 renders the footer error, timeout/terminated warn", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    const theme = buildFakeTheme();
    const render = (message: string): string => {
      const { ctx } = makeRenderCtx();
      ctx.isError = true;
      ctx.args = { command: "false" };
      seedTiming(ctx, 42);
      const component = bash.renderResult!(
        { content: [{ type: "text", text: message }], isError: true } as never,
        { expanded: false, isPartial: false },
        theme,
        ctx,
      ) as TextDouble;
      return component.text.text;
    };
    expect(render("boom\n\nCommand exited with code 1")).toContain(
      `${theme.getFgAnsi("error")}Took 0.0s`,
    );
    expect(render("boom\n\nCommand timed out after 30 seconds")).toContain(
      `${theme.getFgAnsi("warning")}Took 0.0s`,
    );
    expect(render("boom\n\nCommand terminated without an exit code")).toContain(
      `${theme.getFgAnsi("warning")}Took 0.0s`,
    );
  });

  it("non-shell: no badge to refine the kind — the footer renders error", async () => {
    const tools = await registerTools();
    const edit = toolOf(tools, "edit");
    const theme = buildFakeTheme();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/app.ts", edits: [] };
    seedTiming(ctx, 42);
    const component = edit.renderResult!(
      { content: [{ type: "text", text: "nope" }], isError: true } as never,
      { expanded: false, isPartial: false },
      theme,
      ctx,
    ) as TextDouble;
    expect(component.text.text).toContain(`${theme.getFgAnsi("error")}Took 0.0s`);
  });
});

describe("shell exit badge parse (the upstream status lines)", () => {
  it("maps the four upstream status lines to their kinds", () => {
    expect(shellExitBadgeOf("out\n\nCommand exited with code 1")).toEqual({
      kind: "error",
      value: 1,
    });
    expect(shellExitBadgeOf("out\n\nCommand exited with code 143")).toEqual({
      kind: "signal",
      value: 143,
    });
    expect(shellExitBadgeOf("out\n\nCommand timed out after 30 seconds")).toEqual({
      kind: "timeout",
      value: 30,
    });
    expect(shellExitBadgeOf("out\n\nCommand aborted")).toEqual({ kind: "aborted", value: 0 });
    expect(shellExitBadgeOf("out\n\nCommand terminated without an exit code")).toEqual({
      kind: "terminated",
      value: 0,
    });
    expect(shellExitBadgeOf("no status line here")).toBeUndefined();
  });

  it("the badge text is the worded form — ✗ + verb + code, bold, colored by kind", () => {
    const passThrough = buildRenderTheme();
    expect(plain(shellBadgeText({ kind: "error", value: 1 }, passThrough))).toBe("✗ exit 1");
    expect(plain(shellBadgeText({ kind: "signal", value: 143 }, passThrough))).toBe("✗ exit 143");
    expect(plain(shellBadgeText({ kind: "timeout", value: 30 }, passThrough))).toBe(
      "✗ timeout 30s",
    );
    expect(plain(shellBadgeText({ kind: "aborted", value: 0 }, passThrough))).toBe("✗ aborted");
    expect(plain(shellBadgeText({ kind: "terminated", value: 0 }, passThrough))).toBe(
      "✗ terminated",
    );

    // The code-less kinds warn (the single kind→color home); plain exits error.
    const base = buildFakeTheme();
    const warningMarked: PaletteTheme = {
      ...base,
      fg: (name, text) => (name === "warning" ? `«${text}»` : base.fg(name, text)),
    };
    expect(shellBadgeText({ kind: "terminated", value: 0 }, warningMarked)).toContain(
      "✗ terminated",
    );
    expect(shellBadgeText({ kind: "aborted", value: 0 }, warningMarked)).toContain("✗ aborted");
    expect(shellBadgeText({ kind: "error", value: 2 }, warningMarked)).not.toContain("«");
    expect(plain(shellBadgeText({ kind: "error", value: 2 }, warningMarked))).toBe("✗ exit 2");
  });

  it("dims benign exit 1 to muted (no-match, not failure)", () => {
    const theme = buildFakeTheme();
    const exit1 = { kind: "error", value: 1 } as const;
    // Benign heads: text unchanged, color muted.
    for (const cmd of [
      "grep foo",
      "rg --files",
      "test -f a",
      "[ -n x ]",
      "diff a b",
      "git diff --quiet",
    ]) {
      expect(isBenignExit(cmd, exit1)).toBe(true);
      expect(plain(shellBadgeText(exit1, theme, cmd))).toBe("✗ exit 1");
      expect(shellBadgeText(exit1, theme, cmd)).toContain(theme.getFgAnsi("muted"));
    }
    // Non-benign: other codes, other commands, compound commands, unknown.
    expect(isBenignExit("grep foo", { kind: "error", value: 2 })).toBe(false);
    // find/fd exit 1 is a real error (bad path) — their no-match exits 0.
    expect(isBenignExit("find . -name x", exit1)).toBe(false);
    expect(isBenignExit("fd foo", exit1)).toBe(false);
    // git grep shares grep's no-match semantics; [[ is test-family.
    expect(isBenignExit("git grep -q foo", exit1)).toBe(true);
    expect(isBenignExit("[[ 1 == 2 ]]", exit1)).toBe(true);
    // ack documents exit 1 = no match (grep-compatible).
    expect(isBenignExit("ack foo", exit1)).toBe(true);
    // --quiet is a flag: position-free (git diff --cached --quiet).
    expect(isBenignExit("git diff --cached --quiet", exit1)).toBe(true);
    // A newline is a command separator too — the exit may come from line 2.
    expect(isBenignExit("grep foo\nfalse", exit1)).toBe(false);
    expect(isBenignExit("ls", exit1)).toBe(false);
    expect(isBenignExit("grep a | head", exit1)).toBe(false);
    expect(isBenignExit("grep a && echo hi", exit1)).toBe(false);
    expect(isBenignExit("grep 'a|b'", exit1)).toBe(true);
    expect(isBenignExit(undefined, exit1)).toBe(false);
    expect(isBenignExit("grep foo", { kind: "timeout", value: 1 })).toBe(false);
    // Without the command the badge stays error red (fail-closed).
    expect(shellBadgeText(exit1, theme)).toContain(theme.getFgAnsi("error"));
  });
});

describe("grep error frame shape", () => {
  it("renders the body alone (the call header above already carries the pattern + path)", async () => {
    const tools = await registerTools();
    const grep = toolOf(tools, "grep");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { pattern: "needle", path: "/render-project" };

    const component = grep.renderResult!(
      {
        content: [{ type: "text", text: "grep failed: bad regex" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    // Body alone: no row names the tool (the call header already did).
    expect(rows.filter((r) => /\bgrep\b/.test(r) && !r.startsWith("▌"))).toEqual([]);
    expect(rows[0]).not.toBe("");
    expect(rows).toContain("▌ grep failed: bad regex");
  });
});

describe("find error frame shape", () => {
  it("renders the body alone", async () => {
    const tools = await registerTools();
    const find = toolOf(tools, "find");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { pattern: "*.ts", path: "/render-project" };

    const component = find.renderResult!(
      {
        content: [{ type: "text", text: "find failed" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    expect(rows.filter((r) => /\bfind\b/.test(r) && !r.startsWith("▌"))).toEqual([]);
    expect(rows[0]).not.toBe("");
    expect(rows).toContain("▌ find failed");
  });
});

describe("ls error frame shape", () => {
  it("renders the body alone", async () => {
    const tools = await registerTools();
    const ls = toolOf(tools, "ls");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project" };

    const component = ls.renderResult!(
      {
        content: [{ type: "text", text: "ls failed" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    expect(rows.filter((r) => /^\s*ls\b/.test(r))).toEqual([]);
    expect(rows[0]).not.toBe("");
    expect(rows).toContain("▌ ls failed");
  });
});

describe("powershell error frame shape", () => {
  it("follows bash: headless on a recognized badge (the call header carries it)", async () => {
    const tools = await registerTools();
    const pwsh = toolOf(tools, "powershell");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { command: "exit 1" };

    const component = pwsh.renderResult!(
      {
        content: [{ type: "text", text: "\n\nCommand exited with code 1" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    expect(rows.filter((r) => r.includes("powershell"))).toEqual([]);
    expect(rows[0]).toBe("");
    expect(rows.some((r) => r.startsWith("▌ Command exited with code 1"))).toBe(true);
  });
});

describe("error frame bar follows indicatorStyle", () => {
  it("drops the ▌ when indicatorStyle is none (the diff view's own grammar)", async () => {
    // Stage a config that turns the left-edge indicator off.
    vol.mkdirSync("/render-project/.pi/extensions/pigment", { recursive: true });
    vol.writeFileSync(
      "/render-project/.pi/extensions/pigment/config.jsonc",
      JSON.stringify({ indicatorStyle: "none" }),
    );
    const tools = await registerTools({ cwd: "/render-project" });
    const edit = toolOf(tools, "edit");
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.args = { path: "/render-project/app.ts", edits: [] };

    const component = edit.renderResult!(
      {
        content: [{ type: "text", text: "Could not find the exact text" }],
        isError: true,
      } as never,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rows = rowsOf(component);
    // No bar glyph anywhere and NO leading space in the raw frame text:
    // the indicator column collapses entirely — the frame's Box padding
    // is the single leading space the row shows in the terminal.
    expect(rows.some((r) => r.includes("▌"))).toBe(false);
    // The call header's trailing blank is the separator — the body opens
    // on the message row.
    expect(rows[0]).not.toBe("");
    expect(rows).toContain("Could not find the exact text");
  });

  it("drops the ▌ in the write new-file preview too (the add rows are changed rows)", async () => {
    vol.mkdirSync("/render-project/.pi/extensions/pigment", { recursive: true });
    vol.writeFileSync(
      "/render-project/.pi/extensions/pigment/config.jsonc",
      JSON.stringify({ indicatorStyle: "none" }),
    );
    const tools = await registerTools({ cwd: "/render-project" });
    const write = toolOf(tools, "write");
    const content = "export const x = 1;";
    const result = await write.execute!(
      "t-none-indicator",
      { path: "/render-project/fresh.ts", content },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { path: "/render-project/fresh.ts", content };
    const component = write.renderResult!(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as unknown as PreviewTextHost;
    const rendered = plain(await component.previewTask!.render(120));
    expect(rendered).toContain("export const x = 1;");
    // The add rows carry NO bar — the column goes blank like everywhere
    // else (indicatorStyle is the extension's one indicator grammar).
    expect(rendered).not.toContain("▌");
  });
});
