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
 * - plain-while-streaming → highlighted swap (tool-execute.test.ts)
 * - timeout suffix (tool-execute.test.ts)
 * - heredoc injection regions (heredoc-inject.test.ts)
 * - restore path fires the highlight (tool-execute.test.ts)
 *
 * This suite pins the four UNCOVERED scenarios:
 * - theme switch re-highlights (the cache key carries the palette identity)
 * - control bytes in the command defuse at intake (ADR 0004)
 * - the empty command renders the bare prompt
 * - a command superseded mid-highlight never lands (stale guard)
 */

import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "#src/render/tool-services.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  toolOf,
  type TextDouble,
} from "#test/fixtures.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

/**
 * A polled wait (the highlight swap lands on a microtask+invalidate).
 *
 * @param cond - The awaited condition (undefined = not yet).
 * @param ms - The timeout budget.
 * @returns Resolves when the condition holds; rejects on timeout.
 */
async function waitFor(cond: () => boolean | undefined, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met within timeout");
}

beforeEach(() => {
  resetPigmentForTest();
  vol.reset();
  vol.mkdirSync("/render-project", { recursive: true });
  process.env.PI_CODING_AGENT_DIR = "/render-agent";
});

describe("bash call header shape (renderCall)", () => {
  it("re-highlights when the theme identity changes (the cache key carries the palette)", async () => {
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

    // Same command, theme whose DIFF-relevant colors differ (the palette
    // identity — syntax slots are not identity): the cache key must
    // differ and a fresh highlight must fire (the old theme's colors
    // must not ride the cached swap into the new palette's frames).
    const swapsAfterA = invalidated.count;
    const themeB = buildFakeTheme({ diffAdded: "\x1b[38;2;81;220;121m" });
    bash.renderCall({ command: "git status --short" }, themeB, ctx);
    const keyB = ctx.state.commandHighlightFor;
    expect(keyB).not.toBe(keyA);
    await waitFor(() => (invalidated.count > swapsAfterA ? true : undefined));
    const settledB = bash.renderCall({ command: "git status --short" }, themeB, ctx);
    expect(plain((settledB as TextDouble).text.text)).toContain("git status --short");
  });

  it("defuses control bytes in the command at intake (ADR 0004: the command is model-authored data)", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    // An OSC-52 clipboard exfil payload riding the command string.
    const hostile = "echo '\x1b]52;c;AAAAAA\x07'";
    const component = bash.renderCall({ command: hostile }, buildRenderTheme(), ctx);
    const text = (component as TextDouble).text.text;
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
    const text = plain((settled as TextDouble).text.text);
    // One source line stays one rendered row — the old flat parts.join("\n")
    // split the command into three rows at the inline region's mid-line edges.
    expect(text).toBe("$ python3 -c 'print(42)'");
  });

  it("renders the bare prompt for the empty command", async () => {
    const tools = await registerTools();
    const bash = toolOf(tools, "bash");
    if (!bash?.renderCall) throw new Error("bash not registered");
    const { ctx } = makeRenderCtx<ShellState>();
    const component = bash.renderCall({ command: "" }, buildRenderTheme(), ctx);
    const text = plain((component as TextDouble).text.text);
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
    const text = plain((settled as TextDouble).text.text);
    expect(text).toContain("echo beta");
    expect(text).not.toContain("echo alpha");
    expect(ctx.state.command).toBe("echo beta");
  });
});
