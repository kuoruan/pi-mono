/**
 * Tests for the tool-renderer factory: delegation, the error frame, the
 * stats FIFO, text extraction, and the width-aware wrapping contract.
 */

import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createToolRenderer, renderPlainTextFallback } from "#src/render/tool-factory.ts";
import { taskKeyOf } from "#src/render/tool-output.ts";
import {
  buildFakeTheme,
  buildRenderTheme,
  makeRenderCtx,
  makeRenderSession,
  makeTextComponent,
  plain,
  seedTiming,
  type DrivenTaskComponent,
  type TextComponent,
  type TextDouble,
  viewFor,
} from "#test/fixtures.ts";

/** Callable view of a wrapped renderer triple. */
type Wrapped = {
  renderCall: (args: unknown, theme: unknown, ctx: unknown) => unknown;
  renderResult: (result: unknown, options: unknown, theme: unknown, ctx: unknown) => unknown;
};

/**
 * A fake `orig` renderer triple the factory composes over.
 *
 * @param overrides - Optional members overriding the defaults (pass a key
 *   as `undefined` to drop that renderer).
 * @returns The fake renderers and their call log.
 */
function makeOrig(overrides: Partial<ToolRenderers> = {}) {
  const calls: string[] = [];
  const orig = {
    renderShell: "default",
    renderCall(args: unknown, theme: unknown, ctx: unknown) {
      calls.push("renderCall");
      return { kind: "orig-call", args, theme, ctx } as never;
    },
    renderResult(result: unknown, options: unknown, theme: unknown, ctx: unknown) {
      calls.push("renderResult");
      return { kind: "orig-result", result, options, theme, ctx } as never;
    },
    ...overrides,
  } as unknown as ToolRenderers;
  return { orig, calls };
}

/**
 * Build a renderer over an orig from {@link makeOrig} and view it as the
 * test's loose Wrapped shape — THE one cast home for this file.
 *
 * @param orig - The fake renderer triple to compose over.
 * @param spec - The per-test renderer spec.
 * @param name - The tool name (the error frame's label).
 * @returns The renderer triple, loosely typed.
 */
function wrappedFor(
  orig: ToolRenderers,
  spec: Parameters<typeof createToolRenderer>[3] = {},
  name = "probe",
): Wrapped {
  return createToolRenderer(name, orig, services, spec) as unknown as Wrapped;
}

/**
 * Minimal services for the factory (a Text-like factory is only used when
 * the render context carries no lastComponent).
 */
const services = {
  cwd: "/project",
  shortPath: (p: string) => p,
  indicatorStyle: "bar" as const,
  headerEllipsis: "on" as const,
  render: makeRenderSession(),
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
      { content: [{ type: "text", text: "Something failed badly" }] },
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

  it("the error frame's identity carries exactly its documented stamps", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const theme = buildRenderTheme();
    const wrapped = wrappedFor(orig, {});
    const component = wrapped.renderResult(
      { content: [{ type: "text", text: "exploded" }] },
      { expanded: true, isPartial: false },
      theme,
      ctx,
    ) as TextDouble;
    // The full stamp list, spelled out: a dropped or reordered input fails
    // here (identity stability alone stays true either way).
    // scheme.identity embeds a NUL (theme key + roots key joined), so the
    // expected value composes through the same taskKeyOf the call site uses
    // — splitting the identity back apart cannot recover the list.
    expect(component.previewIdentity).toBe(
      // durationMs ?? -1: the unmeasured sentinel (-1, a number — 0ms stays
      // distinguishable from never-measured).
      taskKeyOf("probe", [1, -1, viewFor(theme).scheme.identity, "exploded"]),
    );
  });

  it("the badge stays out of a SHELL error frame's identity stamps too", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const theme = buildRenderTheme();
    const wrapped = wrappedFor(orig, {}, "bash");
    const message = "boom\n\nCommand exited with code 1";
    const component = wrapped.renderResult(
      { content: [{ type: "text", text: message }] },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    ) as TextDouble;
    // The badge is DERIVED from the message (which is already stamped) —
    // it must never join the stamp list as a redundant input.
    expect(component.previewIdentity).toBe(
      taskKeyOf("bash", [0, -1, viewFor(theme).scheme.identity, message]),
    );
  });

  it("the error frame's Took color follows the failure kind", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    seedTiming(ctx, 42);
    const theme = buildFakeTheme();
    const wrapped = wrappedFor(orig, {}, "bash");
    const render = (message: string): string => {
      const component = wrapped.renderResult(
        { content: [{ type: "text", text: message }] },
        { expanded: true, isPartial: false },
        theme,
        ctx,
      ) as TextDouble;
      return component.text.text;
    };
    // The error branch passes durationMs into the frame, which colors the
    // footer by its bar kind: a plain exit renders error, a timeout
    // warns (one failure-kind mapping, no separate footer logic).
    expect(render("boom\n\nCommand exited with code 1")).toContain(
      `${theme.getFgAnsi("error")}Took 0.0s`,
    );
    expect(render("boom\n\nCommand timed out after 30 seconds")).toContain(
      `${theme.getFgAnsi("warning")}Took 0.0s`,
    );
  });

  it("prefers ctx.durationMs (pi's recorded execution time) over the render-state clock", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    // Both sources are present and disagree: the state clock says 7ms,
    // pi's recorded duration says 4200ms. The recorded one wins (1.1.0).
    ctx.durationMs = 4200;
    seedTiming(ctx, 7);
    const component = wrappedFor(orig, {}, "bash").renderResult(
      { content: [{ type: "text", text: "boom" }] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TextDouble;
    expect(plain(component.text.text)).toContain("Took 4.2s");
  });

  it("falls back to the render-state clock when durationMs is absent (1.0.1 / HTML export)", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.durationMs = undefined;
    seedTiming(ctx, 12);
    const component = wrappedFor(orig, {}, "bash").renderResult(
      { content: [{ type: "text", text: "boom" }] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as TextDouble;
    expect(plain(component.text.text)).toContain("Took 0.0s");
  });

  it("the error frame keeps one Took across re-renders of the same call", async () => {
    const { orig } = makeOrig();
    const wrapped = wrappedFor(orig);
    const { ctx, invalidated } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "call-throw";
    // A throw still renders through the live flow (pi marks the execution
    // started before execute), so renderCall arms the clock as usual.
    ctx.executionStarted = true;
    wrapped.renderCall({}, buildRenderTheme(), ctx);
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
    const host = component as DrivenTaskComponent;
    expect(host.previewIdentity).toBeDefined();
    // A re-run of the same error (the TUI's updateDisplay re-render) loses
    // nothing: the first settled frame fixed endedAt, so the duration — and
    // with it the frame identity — is stable. The attach guard (same
    // identity) then leaves the rendered frame alone: no placeholder
    // overwrite.
    host.text.text = "SENTINEL";
    const again = wrapped.renderResult(
      result,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    const againHost = again as DrivenTaskComponent;
    expect(againHost.previewIdentity).toBe(host.previewIdentity);
    expect(againHost.text.text).toBe("SENTINEL"); // the frame was NOT overwritten
    // The attach NEVER invalidates synchronously (the restore-replay loop
    // regression: invalidating during renderResult reset the pruner's batch
    // replay and re-printed the whole session's frames N times) — the
    // async-completion path drives redraws alone.
    expect(invalidated.count).toBe(baselineInvalidations);
  });

  it("returns only the three renderer slots (the factory owns no execution/definition keys)", () => {
    // The session-footprint contract, shifted to the seam: the factory
    // returns renderer slots only, so no execute and no result key can
    // piggyback into what a session persists.
    const { orig } = makeOrig();
    const triple = createToolRenderer("probe", orig, services, {});
    expect(Object.keys(triple).toSorted()).toEqual(["renderCall", "renderResult", "renderShell"]);
  });

  it("the error frame shows Took from the render-state clock", async () => {
    const { orig } = makeOrig();
    const wrapped = wrappedFor(orig);
    const result = { content: [{ type: "text", text: "command failed" }], isError: true };
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "call-return";
    // The live flow: pi marks the execution started, renderCall arms the
    // clock, the settled frame stops it.
    ctx.executionStarted = true;
    wrapped.renderCall({}, buildRenderTheme(), ctx);
    const component = wrapped.renderResult(
      result as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(plain((component as TextDouble).text.text)).toMatch(/Took \d+/);
  });

  it("a replayed error row shows no Took at all (its clock was never armed)", async () => {
    // Session replay re-runs renderCall + renderResult with
    // executionStarted false, so nothing arms the clock — and since no
    // timing is persisted anywhere, the frame carries no duration. This is
    // pi's own replay semantics (its shell renderer's startedAt lives in
    // the render state too), pinned so the footer cannot creep back into
    // the session as a sideband.
    const { orig } = makeOrig();
    const wrapped = wrappedFor(orig);
    const result = { content: [{ type: "text", text: "command failed" }], isError: true };
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "call-replay";
    wrapped.renderCall({}, buildRenderTheme(), ctx);
    expect(ctx.executionStarted).toBe(false);
    const component = wrapped.renderResult(
      result as never,
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(plain((component as TextDouble).text.text)).not.toMatch(/Took/);
  });

  it("the error frame omits Took when no timing is known (a restored session's old errors)", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    ctx.toolCallId = "never-executed";
    const component = wrappedFor(orig).renderResult(
      { content: [{ type: "text", text: "old error" }] },
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
      { content: [{ type: "text", text: "command failed" }] },
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
          { type: "image", data: "xx" },
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
      { content: [] },
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
      { content: [{ type: "text", text: "boom" }] },
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
    const component = renderPlainTextFallback(host, buildRenderTheme(), {
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
      { content: [{ type: "text", text: "x" }] },
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
      { content: [{ type: "text", text: "boom" }] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(cleaned).toBe(true);
  });

  it("hands onError the extracted failure message, every frame (idempotent re-bridge)", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const seen: string[] = [];
    const wrapped = wrappedFor(orig, {
      onError: (_c, message) => {
        seen.push(message);
      },
    });
    const result = {
      content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
    } as never;
    // updateDisplay re-runs renderResult per frame — onError fires each
    // time with the SAME message, so a state-stashed bridge (the shell
    // badge) rewrites idempotently.
    wrapped.renderResult(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    wrapped.renderResult(result, { expanded: true, isPartial: false }, buildRenderTheme(), ctx);
    expect(seen).toEqual([
      "boom\n\nCommand exited with code 1",
      "boom\n\nCommand exited with code 1",
    ]);
  });

  it("hands onError 'Error' when the result carries no text", () => {
    const { orig } = makeOrig();
    const { ctx } = makeRenderCtx();
    ctx.isError = true;
    const seen: string[] = [];
    const wrapped = wrappedFor(orig, {
      onError: (_c, message) => {
        seen.push(message);
      },
    });
    wrapped.renderResult(
      { content: [] },
      { expanded: true, isPartial: false },
      buildRenderTheme(),
      ctx,
    );
    expect(seen).toEqual(["Error"]);
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
      { content: [{ type: "text", text: "ok" }] },
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
