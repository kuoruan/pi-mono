/**
 * Tests for the tool-wrapper factory: delegation, the error frame, the
 * stats FIFO, text extraction, and the width-aware wrapping contract.
 */

import { describe, expect, it } from "vitest";

import { createToolWrapper, renderPlainTextFallback } from "#src/render/tool-factory.ts";
import type { ResultContentBlock } from "#src/render/tool-output.ts";
import {
  makeRenderCtx,
  buildRenderTheme,
  makeTextComponent,
  plain,
  type TextComponent,
  type TextDouble,
} from "#test/fixtures.ts";

/** Callable view of a wrapped tool (ToolDefinition marks methods optional). */
type Wrapped = {
  execute: (
    tid: string,
    params: unknown,
    sig: AbortSignal | undefined,
    upd: unknown,
    ctx: unknown,
  ) => Promise<{ content?: ResultContentBlock[]; isError?: boolean }>;
  renderCall: (args: unknown, theme: unknown, ctx: unknown) => unknown;
  renderResult: (result: unknown, options: unknown, theme: unknown, ctx: unknown) => unknown;
};

/**
 * A fake SDK tool the factory wraps.
 *
 * @param overrides - Optional members overriding the defaults.
 * @returns The fake tool and its call log.
 */
function makeOrig(overrides: Partial<Parameters<typeof createToolWrapper>[0]> = {}) {
  const calls: string[] = [];
  const orig = {
    name: "probe",
    label: "probe",
    description: "probe tool",
    parameters: {},
    async execute(tid: string) {
      calls.push(`execute:${tid}`);
      return {
        content: [{ type: "text" as const, text: "orig executed" }],
        isError: false,
        details: undefined,
      } as never;
    },
    renderCall(args: unknown, theme: unknown, ctx: unknown) {
      calls.push("renderCall");
      return { kind: "orig-call", args, theme, ctx } as never;
    },
    renderResult(result: unknown, options: unknown, theme: unknown, ctx: unknown) {
      calls.push("renderResult");
      return { kind: "orig-result", result, options, theme, ctx } as never;
    },
    ...overrides,
  };
  return { orig: orig as never, calls };
}

/**
 * Wrap an orig from {@link makeOrig} and view it as the test's loose
 * Wrapped shape — THE one cast home for this file (the call sites stay
 * clean).
 *
 * @param orig - The fake SDK tool to wrap.
 * @param spec - The per-test wrapper spec.
 * @returns The wrapped tool, loosely typed.
 */
function wrappedFor(
  orig: ReturnType<typeof makeOrig>["orig"],
  spec: Parameters<typeof createToolWrapper>[2] = {},
): Wrapped {
  return createToolWrapper(orig, services, spec) as unknown as Wrapped;
}

/**
 * Minimal services for the factory (a Text-like factory is only used when
 * the render context carries no lastComponent).
 */
const services = {
  cwd: "/project",
  shortPath: (p: string) => p,
  indicatorStyle: "bar" as const,
  textFactory: class {
    text: { text: string };
    constructor(t: string) {
      this.text = { text: t };
    }
    setText(s: string) {
      this.text.text = s;
    }
    invalidate() {}
    render(_width: number): string[] {
      return [this.text.text];
    }
    setCustomBgFn(_fn?: (line: string) => string) {}
  },
};
describe("execute delegation", () => {
  it("delegates verbatim when the spec has no execute", async () => {
    const { orig, calls } = makeOrig();
    const wrapped = wrappedFor(orig);
    const result = await wrapped.execute("t1", { a: 1 }, undefined, undefined, undefined as never);
    expect(calls).toEqual(["execute:t1"]);
    expect(result.content?.[0]).toMatchObject({ type: "text", text: "orig executed" });
  });

  it("uses the spec's execute when provided", async () => {
    const { orig, calls } = makeOrig();
    const wrapped = wrappedFor(orig, {
      execute: async (tid) => {
        return {
          content: [{ type: "text", text: `custom:${tid}` }],
          isError: false,
          details: undefined,
        } as never;
      },
    });
    const result = await wrapped.execute("t9", {}, undefined, undefined, undefined as never);
    expect(calls).toEqual([]);
    expect(result.content?.[0]).toMatchObject({ type: "text", text: "custom:t9" });
  });
});

describe("renderCall", () => {
  it("delegates to the spec body when provided", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    const wrapped = wrappedFor(orig, {
      renderCall: ({ text }) => {
        text.setText("spec call");
        return text;
      },
    });
    const component = wrapped.renderCall({ x: 1 }, buildRenderTheme(), ctx);
    expect(plain((component as TextDouble).text.text)).toBe("spec call");
  });

  it("falls back to the SDK original without a spec body", () => {
    const { orig, calls } = makeOrig();
    const { ctx } = makeRenderCtx();
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderCall({ x: 1 }, buildRenderTheme(), ctx);
    expect(calls).toEqual(["renderCall"]);
    expect(component).toMatchObject({ kind: "orig-call" });
  });

  it("falls back to the wrapped text when the SDK original has no renderCall", () => {
    const { orig } = makeOrig({ renderCall: undefined });
    const { ctx } = makeRenderCtx();
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderCall({ x: 1 }, buildRenderTheme(), ctx);
    expect((component as { previewWidthAware?: boolean }).previewWidthAware).toBe(true);
  });
});

describe("renderResult error frame", () => {
  it("renders the error frame when ctx.isError is set", () => {
    const { orig, calls } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    let bg: ((line: string) => string) | undefined;
    const text = makeTextWithBgSpy((fn) => (bg = fn));
    ctx.lastComponent = text as never;
    const wrapped = wrappedFor(orig, {
      renderResult: () => {
        throw new Error("spec body must not run for errors");
      },
    });
    const component = wrapped.renderResult(
      { content: [{ type: "text", text: "Something failed badly" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(calls).toEqual([]);
    const rendered = plain((component as TextDouble).text.text);
    // Non-shell frames render the body alone — the tool's call header
    // above already names it, so the frame adds no name row.
    expect(rendered).not.toContain("probe");
    expect(rendered).toContain("Something failed badly");
    // The error frame paints a custom background.
    expect(typeof bg).toBe("function");
  });

  it("the error frame keeps the thrown-span Took across re-renders of the same call", async () => {
    const { orig } = makeOrig({
      async execute() {
        throw new Error("Command exited with code 1");
      },
    });
    const wrapped = wrappedFor(orig);
    await expect(wrapped.execute("call-throw", {}, undefined, undefined, {})).rejects.toThrow(
      "Command exited with code 1",
    );
    const { ctx, invalidated } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "call-throw";
    const result = {
      content: [{ type: "text", text: "output\n\nCommand exited with code 1" }],
    } as never;
    const component = wrapped.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const baselineInvalidations = invalidated.count;
    const rendered = plain((component as TextDouble).text.text);
    expect(rendered).toMatch(/Took \d+/);
    const host = component as {
      text: { text: string };
      previewIdentity?: string;
    };
    expect(host.previewIdentity).toBeDefined();
    // A re-run of the same error (the TUI's updateDisplay re-render) loses
    // nothing: the span record is consumed once, but the resolved
    // milliseconds memo keeps the footer — and the attach guard (same
    // identity) leaves the rendered frame alone: no placeholder overwrite.
    host.text.text = "SENTINEL";
    const again = wrapped.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const againHost = again as unknown as TextDouble & { previewIdentity?: string };
    expect(againHost.previewIdentity).toBe(host.previewIdentity);
    expect(againHost.text.text).toBe("SENTINEL"); // the frame was NOT overwritten
    // The attach NEVER invalidates synchronously (the restore-replay loop
    // regression: invalidating during renderResult reset the pruner's batch
    // replay and re-printed the whole session's frames N times) — the
    // async-completion path drives redraws alone.
    expect(invalidated.count).toBe(baselineInvalidations);
  });

  it("the error frame shows Took from the result sideband when the tool RETURNED an error result", async () => {
    // A returned (not thrown) error result carries the stampElapsed sideband
    // — the same source the success footers read.
    const { orig } = makeOrig({
      async execute() {
        return {
          content: [{ type: "text", text: "command failed" }],
          isError: true,
        } as never;
      },
    });
    const wrapped = wrappedFor(orig);
    // The real flow renders the SAME result object execute returned (the
    // stamp lives on its details) — not a fresh clone.
    const result = await wrapped.execute("call-return", {}, undefined, undefined, {});
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "call-return";
    const component = wrapped.renderResult(
      result as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(plain((component as TextDouble).text.text)).toMatch(/Took \d+/);
  });

  it("the error frame omits Took when no timing is known (a restored session's old errors)", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "never-executed";
    const component = wrappedFor(orig).renderResult(
      { content: [{ type: "text", text: "old error" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(plain((component as TextDouble).text.text)).not.toMatch(/Took/);
  });

  it("takes a fresh Text when the last component is the SDK's Container (bash error path)", () => {
    // Regression: a delegated partial frame leaves the SDK's render
    // component (a Container, no setText) in the slot; the error frame
    // that replaces it must swap in a fresh Text, not call setText on it.
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const container = { render: () => ["sdk partial frame"] } as never;
    ctx.lastComponent = container;
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderResult(
      { content: [{ type: "text", text: "command failed" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    // The returned component is OUR fresh Text (setText worked), carrying
    // the error message — not the SDK container, not a TypeError.
    const rendered = plain((component as TextDouble).text.text);
    expect(rendered).toContain("command failed");
  });

  it("joins multi-block text content for the message", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderResult(
      {
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "xx" } as never,
          { type: "text", text: "second" },
        ],
      } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const rendered = plain((component as TextDouble).text.text);
    expect(rendered).toContain("first");
    expect(rendered).toContain("second");
  });

  it("uses 'Error' when the content is empty", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderResult(
      { content: [] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(plain((component as TextDouble).text.text)).toContain("Error");
  });

  it("replaces any pending diff task with the error frame's own task", async () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderResult(
      { content: [{ type: "text", text: "boom" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TextDouble;
    // The stale diff preview (if one was pending) must never overwrite
    // the error frame: the slot now owns the ERROR FRAME's width-aware
    // task whose render produces the frame (not the old diff body).
    expect(typeof component.previewTask?.render).toBe("function");
    const rendered = plain(await component.previewTask!.render(80));
    expect(rendered).toContain("boom");
    expect(rendered).toContain("▌");
  });
});

describe("renderResult non-error paths", () => {
  it("dims the joined text blocks for the plain fallback (firstTextOf)", () => {
    // renderPlainTextFallback is the spec bodies' unknown-details exit
    // (write's), not the no-spec path — that one delegates to orig.
    const host = makeTextComponent();
    const component = renderPlainTextFallback(host as never, buildRenderTheme(), {
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    } as never) as unknown as TextComponent;
    // The fallback dims the JOINED text blocks (firstTextOf semantics —
    // not just the first block).
    expect(plain(component.text.text)).toContain("line1\nline2");
  });

  it("falls back to the SDK original without a spec body", () => {
    const { orig, calls } = makeOrig();
    const { ctx } = makeRenderCtx();
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderResult(
      { content: [{ type: "text", text: "x" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(calls).toEqual(["renderResult"]);
    expect(component).toMatchObject({ kind: "orig-result" });
  });
});

describe("onError hook", () => {
  it("runs tool-specific cleanup before the error frame renders", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    let cleaned = false;
    const wrapped = wrappedFor(orig, {
      onError: (c) => {
        cleaned = c.isError;
      },
    });
    wrapped.renderResult(
      { content: [{ type: "text", text: "boom" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(cleaned).toBe(true);
  });

  it("does not run on non-error renders", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    let ran = false;
    const wrapped = wrappedFor(orig, {
      onError: () => {
        ran = true;
      },
      renderResult: ({ text }) => text,
    });
    wrapped.renderResult(
      { content: [{ type: "text", text: "ok" }] } as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(ran).toBe(false);
  });
});

/**
 * A Text-like component that records the custom background painter.
 *
 * @param onBg - Receives the painter when set.
 * @returns The component double.
 */
function makeTextWithBgSpy(onBg: (fn: ((line: string) => string) | undefined) => void) {
  const state = { text: "" as string };
  return {
    text: state,
    setText(s: string) {
      state.text = s;
    },
    render: (_width: number): string[] => [state.text],
    setCustomBgFn(fn?: (line: string) => string) {
      onBg(fn);
    },
    previewTask: undefined as unknown,
    customBgFn: undefined as unknown,
    invalidate: () => {},
  };
}
