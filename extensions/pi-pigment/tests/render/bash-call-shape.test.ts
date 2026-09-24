/**
 * THE bash call-header shape suite: every display scenario for the
 * command echo (`$ …`), asserted through the ToolDefinition interface
 * (renderCall) — the seam the TUI itself drives. These are ALL our own
 * chrome: the command display, its highlight cache, and the defusing at
 * intake. The OUTPUT (renderResult) is NOT touched here — it delegates
 * to the SDK's native renderer verbatim (upstream-contracts.test.ts
 * pins that delegation; the faithful-rendering principle forbids
 * re-shaping upstream execution results).
 *
 * Scenarios already pinned elsewhere (not duplicated here):
 *
 * - Plain-while-streaming → highlighted swap (tool-execute.test.ts)
 * - No args timeout suffix even with explicit args (this suite, success-check case)
 * - Heredoc injection regions (heredoc-inject.test.ts)
 * - Restore path fires the highlight (tool-execute.test.ts)
 *
 * This suite pins the four UNCOVERED scenarios:
 *
 * - Theme switch re-highlights (the cache key carries the scheme identity)
 * - Control bytes in the command defuse at intake (ADR 0004)
 * - The empty command renders the bare prompt
 * - A command superseded mid-highlight never lands (stale guard)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "#src/render/tool-services.ts";
import type { PaletteTheme } from "#src/theme/scheme.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  toolOf,
  waitFor,
} from "#test/fixtures.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

beforeEach(() => {
  resetPigmentForTest();
  vol.reset();
  vol.mkdirSync("/render-project", { recursive: true });
  process.env.PI_CODING_AGENT_DIR = "/render-agent";
});

describe("bash call header shape (renderCall)", () => {
  it("re-highlights when the theme identity changes (the cache key carries the scheme)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx, invalidated } = makeRenderCtx<ShellState>();

    // Theme A: the command highlights and caches under A's identity.
    const themeA = buildFakeTheme();
    bash.renderCall({ command: "git status --short" }, themeA, ctx);
    await waitFor(() => (invalidated.count > 0 ? true : undefined));
    bash.renderCall({ command: "git status --short" }, themeA, ctx);
    const keyA = ctx.state.commandHighlightFor;
    expect(keyA).toBeDefined();

    // Same command, theme whose DIFF-relevant colors differ (the scheme
    // identity — syntax slots are not identity): the cache key must
    // differ and a fresh highlight must fire (the old theme's colors
    // must not ride the cached swap into the new scheme's frames).
    const swapsAfterA = invalidated.count;
    const themeB = buildFakeTheme({ diffAdded: "\x1b[38;2;81;220;121m" });
    bash.renderCall({ command: "git status --short" }, themeB, ctx);
    const keyB = ctx.state.commandHighlightFor;
    expect(keyB).not.toBe(keyA);
    await waitFor(() => (invalidated.count > swapsAfterA ? true : undefined));
    const settledB = bash.renderCall({ command: "git status --short" }, themeB, ctx);
    expect(plain(settledB.text.text)).toContain("git status --short");
  });

  it("re-colors the badge suffix on a theme switch", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    ctx.isError = true;
    ctx.state.exitBadge = { kind: "error", value: 1 };
    const themeA = buildFakeTheme();
    const aCall = bash.renderCall({ command: "false" }, themeA, ctx);
    expect(plain(aCall.text.text)).toBe("$ false · ✗ exit 1");
    const base = buildFakeTheme();
    const themeB: PaletteTheme = {
      ...base,
      fg: (name, text) => (name === "error" ? `<${text}>` : base.fg(name, text)),
    };
    const bCall = bash.renderCall({ command: "false" }, themeB, ctx);
    expect(plain(bCall.text.text)).toContain("✗ exit 1");
    expect(bCall.text.text).toContain("<");
    expect(bCall.text.text).not.toContain(themeA.getFgAnsi("error"));
  });

  it("defuses control bytes in the command at intake (ADR 0004: the command is model-authored data)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    // An OSC-52 clipboard exfil payload riding the command string.
    const hostile = "echo '\x1b]52;c;AAAAAA\x07'";
    const component = bash.renderCall({ command: hostile }, buildRenderTheme(), ctx);
    const text = component.text.text;
    // No raw OSC/ESC reaches the terminal as a live sequence — the
    // payload renders inert (caret notation), the command still legible.
    // eslint-disable-next-line no-control-regex -- the payload IS control bytes
    expect(text).not.toMatch(/\x1b\]/);
    // eslint-disable-next-line no-control-regex -- ditto: the OSC terminator
    expect(text).not.toMatch(/\x07/);
    expect(plain(text)).toContain("echo");
  });

  it("reassembles an inline code region on its ORIGINAL line (python -c stays one row)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx, invalidated } = makeRenderCtx<ShellState>();
    bash.renderCall({ command: "python3 -c 'print(42)'" }, buildRenderTheme(), ctx);
    await waitFor(() => (invalidated.count > 0 ? true : undefined));
    const settled = bash.renderCall({ command: "python3 -c 'print(42)'" }, buildRenderTheme(), ctx);
    const text = plain(settled.text.text);
    // One source line stays one rendered row — the old flat parts.join("\n")
    // split the command into three rows at the inline region's mid-line edges.
    // (The status suffix is separate grammar, pinned in the success test.)
    expect(text).toContain("$ python3 -c 'print(42)'");
  });

  it("renders the bare prompt for the empty command", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    // An empty command renders while streaming (pending — settled empties
    // fail SDK validation), where the header is bare regardless.
    ctx.isPartial = true;
    const component = bash.renderCall({ command: "" }, buildRenderTheme(), ctx);
    const text = plain(component.text.text);
    // The prompt alone; no highlight task fires for the empty command.
    expect(text).toBe("$ ");
    expect(ctx.state.commandHighlightFor).toBeUndefined();
  });

  it("never lands a superseded command's highlight (the stale guard)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx, invalidated } = makeRenderCtx<ShellState>();
    const theme = buildRenderTheme();

    // Command A (args complete) starts its async highlight…
    bash.renderCall({ command: "echo alpha" }, theme, ctx);
    // …but the command moves on to B before A's highlight resolves.
    bash.renderCall({ command: "echo beta" }, theme, ctx);
    await waitFor(() => (invalidated.count > 0 ? true : undefined));

    // Whichever highlight landed, the text shows B — A's colors/text
    // must never appear (state.command moved past it).
    const settled = bash.renderCall({ command: "echo beta" }, theme, ctx);
    const text = plain(settled.text.text);
    expect(text).toContain("echo beta");
    expect(text).not.toContain("echo alpha");
    expect(ctx.state.command).toBe("echo beta");
  });
});

/**
 * The call-header status suffix's INLINE surface: the header stays a bare
 * `$ cmd` / `PS> cmd` while pending (no state glyph), and once the call
 * settles the suffix rides the echo after a muted `·` separator — success
 * the plain check (`· ✓`), failure the badge onError bridged (`· ✗ exit 1`
 * — error-frame's badge semantics) — composed fresh at setText on BOTH
 * display paths, never into the highlight cache. The error frame's own
 * (headless-on-hit) shape lives in error-frame-shape.test.ts.
 */
describe("shell call header failure badge (renderCall)", () => {
  it("renders the bare prompt line while pending — no state mark", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const theme = buildRenderTheme();

    const { ctx: streaming } = makeRenderCtx<ShellState>();
    streaming.isPartial = true;
    const pending = bash.renderCall({ command: "echo hi" }, theme, streaming);
    expect(plain(pending.text.text)).toBe("$ echo hi");
  });

  it("rides the success check as the suffix on both display paths", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const theme = buildFakeTheme();
    // Explicit timeout args render no declaration suffix either.
    const timeoutArgs = bash.renderCall(
      { command: "sleep 100", timeout: 30 },
      theme,
      makeRenderCtx<ShellState>().ctx,
    );
    expect(plain(timeoutArgs.text.text)).toBe("$ sleep 100 · ✓");
    const { ctx, invalidated } = makeRenderCtx<ShellState>();

    // Plain path (pre-highlight): the settled success frame grows `· ✓`.
    const plainCall = bash.renderCall({ command: "echo hi" }, theme, ctx);
    expect(plain(plainCall.text.text)).toBe("$ echo hi · ✓");
    // The `·` separator is muted, the ✓ bold in the success color — the
    // failure suffix's exact shape mirrored.
    expect(plainCall.text.text).toContain(`${theme.getFgAnsi("muted")}·`);
    expect(plainCall.text.text).toContain(theme.getFgAnsi("success"));

    // Cached path: the same suffix composes fresh around the highlight.
    await waitFor(() => (invalidated.count > 0 ? true : undefined));
    const cached = bash.renderCall({ command: "echo hi" }, theme, ctx);
    expect(plain(cached.text.text)).toBe("$ echo hi · ✓");
    expect(cached.text.text).toContain(theme.getFgAnsi("success"));
    // The cache itself stays command-only — the ✓ is per-frame composition.
    expect(ctx.state.commandHighlight).toBeDefined();
    expect(plain(ctx.state.commandHighlight!)).toBe("echo hi");
  });

  it("carries the worded failure badge as the suffix on the plain path", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    // Error WITHOUT a bridged badge: the header stays bare — degraded,
    // never broken (the frame below names the tool instead).
    ctx.isError = true;
    const unbadged = bash.renderCall({ command: "false" }, buildRenderTheme(), ctx);
    expect(plain(unbadged.text.text)).toBe("$ false");
    // The badge lands: the echo grows the worded suffix.
    ctx.state.exitBadge = { kind: "error", value: 1 };
    const call = bash.renderCall({ command: "false" }, buildRenderTheme(), ctx);
    expect(plain(call.text.text)).toBe("$ false · ✗ exit 1");
  });

  it("composes the badge fresh on the cached path too — the cache stays badge-free", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx, invalidated } = makeRenderCtx<ShellState>();
    const theme = buildFakeTheme();
    bash.renderCall({ command: "git status --short" }, theme, ctx);
    await waitFor(() => (invalidated.count > 0 ? true : undefined));

    // The error lands: the NEXT call-header frame serves the cached
    // highlight but composes the badge suffix around it fresh.
    ctx.isError = true;
    ctx.state.exitBadge = { kind: "error", value: 1 };
    const call = bash.renderCall({ command: "git status --short" }, theme, ctx);
    expect(plain(call.text.text)).toBe("$ git status --short · ✗ exit 1");
    // The suffix rides the badge's kind color — the bold ✗-worded form,
    // not a bare glyph.
    expect(call.text.text).toContain(theme.getFgAnsi("error"));
    // The `·` separator is muted — the footer dot's color.
    expect(call.text.text).toContain(`${theme.getFgAnsi("muted")}·`);

    // A warning-kind badge (timeout) carries its kind color, not error red.
    ctx.state.exitBadge = { kind: "timeout", value: 30 };
    const timeoutCall = bash.renderCall({ command: "git status --short" }, theme, ctx);
    expect(plain(timeoutCall.text.text)).toBe("$ git status --short · ✗ timeout 30s");
    expect(timeoutCall.text.text).toContain(theme.getFgAnsi("warning"));

    // And the cache itself holds the command alone: the badge is the
    // per-frame composition, not cached content.
    const cachedCommand = ctx.state.commandHighlight;
    expect(cachedCommand).toBeDefined();
    expect(plain(cachedCommand!)).toBe("git status --short");
    expect(cachedCommand).not.toContain("✗");
  });

  it("dims a benign no-match exit 1 (grep) to muted", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    const theme = buildFakeTheme();
    ctx.isError = true;
    ctx.state.exitBadge = { kind: "error", value: 1 };
    const call = bash.renderCall({ command: "grep foo bar" }, theme, ctx);
    expect(plain(call.text.text)).toBe("$ grep foo bar · ✗ exit 1");
    expect(call.text.text).toContain(theme.getFgAnsi("muted"));
    expect(call.text.text).not.toContain(theme.getFgAnsi("error"));
  });

  it("renders no args timeout suffix, explicit args included", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    ctx.isError = true;
    ctx.state.exitBadge = { kind: "timeout", value: 30 };
    const call = bash.renderCall({ command: "sleep 100", timeout: 30 }, buildRenderTheme(), ctx);
    // ONE "✗ timeout 30s" — the badge's; the args' explicit timeout adds nothing.
    expect(plain(call.text.text)).toBe("$ sleep 100 · ✗ timeout 30s");

    // A non-timeout badge too: no "(timeout Ns)" declaration stands beside it.
    ctx.state.exitBadge = { kind: "error", value: 1 };
    const both = bash.renderCall({ command: "sleep 100", timeout: 30 }, buildRenderTheme(), ctx);
    expect(plain(both.text.text)).toBe("$ sleep 100 · ✗ exit 1");
  });

  it("clears a stale failure badge when a new execution re-arms the state", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    ctx.state.exitBadge = { kind: "error", value: 1 };
    // A fresh live execution re-arms the clock — the previous failure's
    // badge must not ride the new call's header.
    ctx.executionStarted = true;
    ctx.state.startedAt = undefined;
    const call = bash.renderCall({ command: "echo next" }, buildRenderTheme(), ctx);
    expect(plain(call.text.text)).toBe("$ echo next · ✓");
  });

  it("powershell rides the same grammar (terminated badge)", async () => {
    const tools = await registerTools();
    const pwsh = toolOf(tools, "powershell");
    if (!pwsh?.renderCall) throw new Error("powershell not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    ctx.isError = true;
    ctx.state.exitBadge = { kind: "terminated", value: 0 };
    const call = pwsh.renderCall({ command: "exit 1" }, buildRenderTheme(), ctx);
    expect(plain(call.text.text)).toBe("PS> exit 1 · ✗ terminated");
  });

  it("powershell follows the same suffix on success", async () => {
    const tools = await registerTools();
    const pwsh = toolOf(tools, "powershell");
    if (!pwsh?.renderCall) throw new Error("powershell not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    const call = pwsh.renderCall({ command: "Get-ChildItem" }, buildRenderTheme(), ctx);
    expect(plain(call.text.text)).toBe("PS> Get-ChildItem · ✓");
  });
});
