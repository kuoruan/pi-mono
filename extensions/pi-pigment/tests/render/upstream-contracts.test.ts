/**
 * UPSTREAM CONTRACTS — the tests that exercise the SDK's own rendering
 * machinery (native renderers, ambient theme, real package files) rather
 * than pi-pigment's wrappers in isolation. One file so they share a single
 * initTheme (a multi-second ambient-theme load under the test runner) and
 * a single process; memfs is useless here by construction.
 *
 * Real-filesystem note: initTheme reads builtin theme JSON from the SDK
 * package — a memfs mock would break that read.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createShellWrapper } from "#src/render/shell-tool.ts";
import {
  buildRenderTheme,
  makeRenderCtx,
  registerTools,
  toolOf,
  plain,
  type TextDouble,
} from "#test/fixtures.ts";

// Session isolation: registerTools must not read the developer's real
// config layers (a global disabledTools/syntaxTheme would flip this suite).
const isolatedDir = mkdtempSync(join(tmpdir(), "pi-pigment-upstream-"));
afterAll(() => rmSync(isolatedDir, { recursive: true, force: true }));

beforeAll(() => {
  // The native renderers read the ambient theme (a module-level getter
  // initialized like a real pi session; no watcher — it polls and hangs).
  initTheme(undefined, false);
}, 60000);

// ---------------------------------------------------------------------------
// bash output delegation
// ---------------------------------------------------------------------------

/**
 * The bash output renders through the SDK's NATIVE result renderer (timing,
 * preview windows, truncation footers) — our wrapper delegates wholesale.
 */
describe("bash output delegation (renderResult)", () => {
  it(
    "renders the output through the SDK's native result renderer",
    { timeout: 20000 },
    async () => {
      const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
      const bash = tools.find((t) => t.name === "bash");
      if (!bash?.renderResult) throw new Error("bash not registered");
      const { ctx } = makeRenderCtx();
      // A lastComponent (from our renderCall) must be withheld — the SDK
      // renderer builds its own Container, never our width-aware Text.
      const textish = { render: () => [""], setText: () => {} };
      const component = bash.renderResult(
        { content: [{ type: "text", text: "hello from bash\n" }] } as never,
        { expanded: true, isPartial: false },
        buildRenderTheme(),
        { ...ctx, lastComponent: textish as never },
      );
      expect(component).toBeDefined();
      expect(component).not.toBe(textish);
      expect((component as { children?: unknown[] }).children?.length).toBeGreaterThan(0);
    },
  );
});

describe("bash onError: the native timing interval", () => {
  // The SDK bash result renderer parks a 1-second invalidate interval in
  // state while output streams and clears it in its own final render — the
  // render the factory's error frame bypasses. The shell wrapper's onError
  // hook owns that cleanup; without it every failed command leaks a
  // re-render loop for the rest of the session.
  it("clears the interval and stamps endedAt when the error frame intercepts", () => {
    const wrapped = createShellWrapper(
      createBashToolDefinition(process.cwd()) as never,
      {
        shortPath: (p: string) => p,
        indicatorStyle: "bar",
        textFactory: Text,
      },
      { language: "shellscript", prompt: "$" },
    ) as unknown as {
      renderResult: (
        result: unknown,
        options: { expanded: boolean; isPartial: boolean },
        theme: unknown,
        ctx: unknown,
      ) => unknown;
    };
    vi.useFakeTimers();
    try {
      const { ctx } = makeRenderCtx();
      ctx.state.startedAt = Date.now();
      // Arm the interval exactly as the native renderer does mid-stream.
      const interval = setInterval(() => ctx.invalidate(), 1000);
      (ctx.state as { interval?: unknown }).interval = interval;
      ctx.isError = true;
      wrapped.renderResult(
        { content: [{ type: "text", text: "boom" }] },
        { expanded: true, isPartial: false },
        buildRenderTheme(),
        ctx,
      );
      expect((ctx.state as { interval?: unknown }).interval).toBeUndefined();
      expect((ctx.state as { endedAt?: number }).endedAt).toBeTypeOf("number");
      clearInterval(interval);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// edit session compatibility (ADR 0005, amended)
// ---------------------------------------------------------------------------

describe("edit session compatibility (native renderer on pi-pigment results)", () => {
  it("the NATIVE renderer renders a pi-pigment-executed result", { timeout: 20000 }, async () => {
    // The old parse-and-replace execute dropped the SDK's
    // diff/firstChangedLine details — the native renderer's
    // formatEditResult then returned nothing (empty body). Verbatim
    // delegation keeps every field the native path reads.
    const file = join(isolatedDir, "compat.ts");
    writeFileSync(file, "const a = 1;\n");
    // agentDir isolated; cwd the temp dir (the native edit renderer's fs
    // is a contract requirement).
    const tools = await registerTools({ cwd: isolatedDir, agentDir: isolatedDir });
    const edit = toolOf(tools, "edit");
    if (!edit.execute) throw new Error("edit.execute missing");
    const result = await edit.execute(
      "t-compat",
      { path: file, edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }] },
      undefined,
      undefined,
      undefined,
    );

    const native = createEditToolDefinition(isolatedDir);
    const { ctx } = makeRenderCtx();
    ctx.args = { path: file };
    // The native renderer mutates its lastComponent in place
    // (clear + addChild) — hand it a REAL Container, as the TUI does.
    const container = new Container();
    const component = (native.renderResult as NonNullable<typeof native.renderResult>)(
      // The fixture's execute returns AgentToolResult<unknown>; the native
      // renderer expects its own EditToolDetails — the delegation contract,
      // cast at the seam (the test asserts the fields ARE present).
      result as never,
      { expanded: true, isPartial: false },
      buildRenderTheme() as never,
      { ...ctx, lastComponent: container } as never,
    ) as unknown as TextDouble;
    const rendered = plain(component.render(120).join("\n"));
    // The native renderer renders the unified diff from its details.
    expect(rendered).toContain("const a = 42;");
  });
});

// ---------------------------------------------------------------------------
// the upstream took guard
// ---------------------------------------------------------------------------

/**
 * Pi-pigment renders `Took Xs` footers on grep/find/ls results (the
 * factory-measured elapsed-ms sideband). The SDK's own renderers do NOT —
 * as of pi 2.7.0, only bash/powershell carry native timing (`Took`/
 * `Elapsed` lines in their result renderers).
 *
 * If this test FAILS, upstream started rendering timing on these tools —
 * upstream now owns the feature. Decide per tool between delegating
 * output rendering wholesale (the bash pattern) or knowingly keeping
 * ours redundant; simply dropping our footer would NOT surface the
 * native one (pi-pigment replaces renderResult entirely — it never calls
 * the original). This sentinel exists so the change is noticed in a
 * test run, not in a screenshot.
 */
describe("upstream took guard (native renderers stay timing-free)", () => {
  const THEME = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    bg: (_name: string, text: string) => text,
  } as never;

  const renderNative = (
    tool: { renderResult?: unknown },
    output: string,
    options: { expanded: boolean; isPartial: boolean },
  ): string => {
    const renderer = tool.renderResult as
      | ((
          result: unknown,
          options: unknown,
          theme: unknown,
          ctx: unknown,
        ) => { render?: (width: number) => string[] } | unknown)
      | undefined;
    if (!renderer) return "";
    const component = renderer(
      { content: [{ type: "text", text: output }] },
      options,
      THEME,
      {},
    ) as { render?: (width: number) => string[] };
    return (component?.render?.(120) ?? []).join("\n");
  };

  // Both modes AND streaming: affordances (including any future timing)
  // live on the collapsed tail, and bash's native timing first appears
  // while isPartial — expanded-final alone is the least risky mode.
  const MODES: Array<{ expanded: boolean; isPartial: boolean }> = [
    { expanded: true, isPartial: false },
    { expanded: false, isPartial: false },
    { expanded: true, isPartial: true },
    { expanded: false, isPartial: true },
  ];
  const longOutput = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");

  it("native grep renders no timing (all modes)", () => {
    const tool = createGrepToolDefinition(process.cwd());
    for (const mode of MODES) {
      expect(renderNative(tool, longOutput, mode)).not.toMatch(/Took \d|Elapsed \d/);
    }
  });

  it("native find renders no timing (all modes)", () => {
    const tool = createFindToolDefinition(process.cwd());
    for (const mode of MODES) {
      expect(renderNative(tool, longOutput, mode)).not.toMatch(/Took \d|Elapsed \d/);
    }
  });

  it("native ls renders no timing (all modes)", () => {
    const tool = createLsToolDefinition(process.cwd());
    for (const mode of MODES) {
      expect(renderNative(tool, longOutput, mode)).not.toMatch(/Took \d|Elapsed \d/);
    }
  });
});
