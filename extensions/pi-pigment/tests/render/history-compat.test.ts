/**
 * Resume fidelity, pinned: a session's write/edit entries replay through
 * renderResult whatever generation wrote them. The MODERN dialect
 * (pi-pigment's kind discriminators, the SDK's diff/patch stash) renders
 * its diffs; the historical dialects (pi-shiki-diff's parsedDiff, the
 * SDK native _type:new, the empty-details era) fall back to the
 * plain-text line — deliberate non-compat (ADR 0005's no-shim stance):
 * each generation rendered its own; translating dead dialects is not
 * this renderer's job. This test pins THAT boundary with synthetic
 * entries (one per dialect, the shapes observed in real sessions) so a
 * future regression in the modern shapes' resume rendering cannot hide.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  registerTools,
  buildFakeTheme,
  type DrivenTaskComponent,
  type TextDouble,
} from "#test/fixtures.ts";

/** One synthetic history entry: a tool result + its paired call args. */
interface HistoryEntry {
  tool: "write" | "edit";
  details: Record<string, unknown> | undefined;
  args: Record<string, unknown> | undefined;
  /** The expected outcome (rendered vs the deliberate fallback). */
  expectRendered: boolean;
}

/** A minimal edit-toolInput args pair (path + one edit). */
const EDIT_ARGS = {
  path: "/project/src/app.ts",
  edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
};

/** A write args pair with full content (the render-time content source). */
const WRITE_ARGS = { path: "/project/src/new.ts", content: "const value = 1;\n" };

/** The synthetic session: every dialect, one entry each. */
const HISTORY: HistoryEntry[] = [
  // ── The modern dialect (renders) ──
  {
    tool: "write",
    details: { kind: "diff", diff: { lines: [], added: 1, removed: 1 }, language: "ts" },
    args: WRITE_ARGS,
    expectRendered: true,
  },
  {
    tool: "write",
    details: { kind: "new", filePath: "/project/src/new.ts" },
    args: WRITE_ARGS,
    expectRendered: true,
  },
  { tool: "write", details: { kind: "noChange" }, args: WRITE_ARGS, expectRendered: true },
  {
    tool: "edit",
    details: {
      diff: "old",
      patch: "--- a\n+++ b\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
      firstChangedLine: 1,
    },
    args: EDIT_ARGS,
    expectRendered: true,
  },
  // ── The dead dialects (deliberate fallback; ADR 0005's no-shim stance) ──
  {
    tool: "write",
    details: { _type: "new", content: "x", filePath: "/p.ts", lines: 1 },
    args: WRITE_ARGS,
    expectRendered: false,
  }, // pi SDK native
  { tool: "write", details: undefined, args: WRITE_ARGS, expectRendered: false }, // the empty-details era
  { tool: "edit", details: undefined, args: EDIT_ARGS, expectRendered: false }, // ditto; native edit errors too
  {
    tool: "edit",
    details: { language: "ts", parsedDiff: { lines: [], added: 1, removed: 1 } },
    args: EDIT_ARGS,
    expectRendered: false,
  }, // pi-shiki-diff's dialect
];

/**
 * Drive one entry through the registered wrapper's renderResult. The
 * synthetic result carries a marker content block: the fallback renders
 * it (dim plain text), the rendered dialects ignore it — one signal
 * separates the two outcomes.
 *
 * @param tool - The registered tool wrapper.
 * @param details - The historical details shape.
 * @param args - The paired call arguments.
 * @returns The rendered text and whether an async task attached.
 */
function driveRender(
  tool: { renderResult?: (r: unknown, o: unknown, t: unknown, c: unknown) => unknown },
  details: Record<string, unknown> | undefined,
  args: Record<string, unknown> | undefined,
): { text: string; taskAttached: boolean } {
  const result = { content: [{ type: "text", text: "FALLBACK-MARKER" }] };
  // No lastComponent: the factory takes a fresh real Text (the swap-in
  // path under test is the result render, not component reuse).
  const ctx = {
    args,
    state: {},
    invalidate: () => {},
    cwd: "/project",
  };
  const component = tool.renderResult!(
    { ...result, details },
    { expanded: false, isPartial: false },
    buildFakeTheme({ syntaxColors: true }),
    ctx,
  ) as DrivenTaskComponent;
  // The component is a Text-like; read its current text (a getter or field).
  const host = component as unknown as {
    getText?: () => string;
    text?: { text?: string } | string;
  };
  const text =
    typeof host.getText === "function"
      ? host.getText()
      : typeof host.text === "string"
        ? host.text
        : String(host.text?.text ?? "");
  return { text, taskAttached: (component as TextDouble).previewTask !== undefined };
}

describe("history session compat (synthetic dialects)", () => {
  it("renders the modern shapes, falls back on the dead ones", async () => {
    // A cwd that exists nowhere: the config layers find no file.
    const tools = await registerTools({ cwd: "/nonexistent-pi-pigment-hist" });
    const write = tools.find((t) => t.name === "write");
    const edit = tools.find((t) => t.name === "edit");
    expect(write?.renderResult).toBeDefined();
    expect(edit?.renderResult).toBeDefined();

    for (const entry of HISTORY) {
      const tool = entry.tool === "write" ? write : edit;
      const { text, taskAttached } = driveRender(tool!, entry.details, entry.args);
      // The fallback renders the marker content (dim, taskless); the
      // rendered dialects either attach an async task, draw the box, or
      // (noChange) render empty — never the marker.
      const fellBack = !taskAttached && text.includes("FALLBACK-MARKER");
      expect(
        fellBack,
        `${entry.tool} details=${JSON.stringify(entry.details ?? null)} → text=${JSON.stringify(text.slice(0, 60))}`,
      ).toBe(!entry.expectRendered);
    }
  });
});
