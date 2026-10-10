/**
 * UPSTREAM CONTRACTS — the tests that exercise the SDK's own rendering
 * machinery (native renderers, ambient theme, real package files) rather
 * than pi-pigment's renderers in isolation. One file so they share a single
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
  type ToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  initTheme,
  keyHint,
  keyText,
} from "@earendil-works/pi-coding-agent";
import { Container, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bashProfile, createShellRenderer } from "#src/render/shell-tool.ts";
import { expandKeyHint } from "#src/render/tool-output.ts";
import type { RenderContext } from "#src/render/tool-services.ts";
import type { RenderTheme } from "#src/theme/scheme.ts";
import {
  type RenderResultCarrier,
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  toolOf,
  type TextDouble,
  makeServices,
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

/**
 * Pigment's expand affordance mirrors pi's `keyHint` byte for byte (the
 * same `fg("dim", keyText(id)) + fg("muted", " " + description)` split).
 * The mirror is deliberate — pi's helper paints the ambient theme global
 * and cannot take a theme, while pigment's renderers speak the theme
 * instance pi handed them — so this pin is what keeps the two from
 * drifting when pi restyles its own affordance.
 */
/** The SDK's cross-module theme global, read directly (keyHint's own seam). */
type GlobalThisWithTheme = typeof globalThis & Record<symbol, RenderTheme | undefined>;

/** The shared ambient-theme key (theme.js's Symbol.for). */
const AMBIENT_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
describe("expand-key hint parity with the SDK's keyHint", () => {
  it("composes the same bytes (ambient theme, app binding installed)", () => {
    // The app installs its keybinding table at startup (its own
    // KeybindingsManager over the app definitions); install the same
    // expand binding here so keyText resolves pi's real default.
    setKeybindings(
      new KeybindingsManager({
        "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
      }),
    );
    expect(keyText("app.tools.expand")).toBe("ctrl+o");
    // The ambient instance initTheme parked in the SDK's cross-module
    // global — the exact object keyHint paints (its internal key, the
    // documented sharing seam between SDK module instances).
    const ambient = (globalThis as unknown as GlobalThisWithTheme)[AMBIENT_THEME_KEY];
    if (!ambient) throw new Error("ambient theme missing after initTheme");
    expect(expandKeyHint(ambient)).toBe(keyHint("app.tools.expand", "to expand"));
  });
});

/**
 * The bash output renders through the SDK's NATIVE result renderer (timing,
 * preview windows, truncation footers) — our renderer delegates wholesale.
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
        { content: [{ type: "text", text: "hello from bash\n" }] },
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

/** The SDK's render slot (the 4th `renderResult` parameter) for the default generics. */
type SdkRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/** The SDK context fields `RenderContext` deliberately does not carry. */
type ProjectedContextFields = "args" | "showImages" | "state";

/**
 * Compile-time canary, same pattern as ALL_BASH_OPTIONS_ACCOUNTED_FOR: an
 * upstream field added to the render context stops this line compiling,
 * and whoever bumps the SDK decides whether `RenderContext` (and so every
 * renderer renderer) should carry it — otherwise the TUI starts passing a
 * field no renderer ever sees.
 */
const CONTEXT_FIELDS_ACCOUNTED_FOR: [Exclude<keyof SdkRenderContext, keyof RenderContext>] extends [
  ProjectedContextFields,
]
  ? true
  : false = true;

describe("render context projection (upstream drift)", () => {
  it("accounts for every SDK render-context field", () => {
    // The assertion is the type of CONTEXT_FIELDS_ACCOUNTED_FOR (compiled
    // by `tsc`); this keeps the value in the report.
    expect(CONTEXT_FIELDS_ACCOUNTED_FOR).toBe(true);
  });
});

describe("bash onError: the native timing interval", () => {
  // The SDK bash result renderer parks a 1-second invalidate interval in
  // state while output streams and clears it in its own final render — the
  // render the factory's error frame bypasses. The shell renderer's onError
  // hook owns that cleanup; without it every failed command leaks a
  // re-render loop for the rest of the session.
  it("clears the interval and stamps endedAt when the error frame intercepts", () => {
    const wrapped = createShellRenderer(
      createBashToolDefinition(process.cwd()) as never,
      makeServices({ headerEllipsis: "on" }),
      bashProfile,
    ) as unknown as RenderResultCarrier;
    vi.useFakeTimers();
    try {
      const { ctx } = makeRenderCtx();
      ctx.state.startedAt = Date.now();
      // Arm the interval exactly as the native renderer does mid-stream.
      const interval = setInterval(() => ctx.invalidate(), 1000);
      (ctx.state as { interval?: unknown }).interval = interval;
      ctx.isError = true;
      wrapped.renderResult(
        // The message carries the SDK's appended status line — onError
        // bridges it into the render state (the call header's badge).
        { content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }] },
        { expanded: true, isPartial: false },
        buildRenderTheme(),
        ctx,
      );
      expect((ctx.state as { interval?: unknown }).interval).toBeUndefined();
      expect((ctx.state as { endedAt?: number }).endedAt).toBeTypeOf("number");
      expect((ctx.state as { exitBadge?: unknown }).exitBadge).toEqual({ kind: "error", value: 1 });
      clearInterval(interval);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
