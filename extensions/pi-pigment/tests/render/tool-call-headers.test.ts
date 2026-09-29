/**
 * ALL tools' call-header rendering, pinned through the ToolDefinition
 * interface (renderCall) — the seam the TUI itself drives. Two invariants
 * hold for every header:
 *
 * 1. The trailing blank follows the call state (renderHeaderLine's default): pending frames end
 *    without "\n" (the shell padding supplies the gap), settled frames end with one.
 *    Bash/powershell are the exception: their headers never separate (the native result renderer
 *    owns the layout below).
 * 2. The header echoes the key args (the settled-args contract: args are present every frame, live and
 *    restored alike).
 */
import { describe, expect, it } from "vitest";

import {
  buildRenderTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  toolOf,
} from "#test/fixtures.ts";

/**
 * Render one header frame, plain-text.
 *
 * @param name - The tool name.
 * @param args - The call args.
 * @param isPartial - The pending state.
 * @returns The plain header text.
 */
async function headerText(name: string, args: unknown, isPartial: boolean): Promise<string> {
  resetPigmentForTest();
  const tools = await registerTools();
  const tool = toolOf(tools, name);
  const { ctx } = makeRenderCtx();
  ctx.args = args;
  ctx.isPartial = isPartial;
  const component = tool.renderCall!(args, buildRenderTheme(), ctx as never) as {
    text: { text: string };
  };
  return plain(component.text.text);
}

describe("tool call headers", () => {
  const cases: { name: string; args: unknown; marker: string; settledBlank: boolean }[] = [
    { name: "read", args: { path: "src/a.ts" }, marker: "src/a.ts", settledBlank: true },
    {
      name: "write",
      args: { path: "src/a.ts", content: "x" },
      marker: "src/a.ts",
      settledBlank: true,
    },
    {
      name: "edit",
      args: { path: "src/a.ts", edits: [] },
      marker: "src/a.ts",
      settledBlank: true,
    },
    {
      name: "grep",
      args: { pattern: "foo", path: "src" },
      marker: "/foo/",
      settledBlank: true,
    },
    {
      name: "find",
      args: { pattern: "*.ts", path: "src" },
      marker: "*.ts",
      settledBlank: true,
    },
    { name: "ls", args: { path: "src" }, marker: "src", settledBlank: true },
    { name: "bash", args: { command: "ls -la" }, marker: "ls -la", settledBlank: false },
    {
      name: "powershell",
      args: { command: "Get-ChildItem" },
      marker: "Get-ChildItem",
      settledBlank: false,
    },
  ];

  for (const { name, args, marker, settledBlank } of cases) {
    it(`${name} echoes its key args`, async () => {
      expect(await headerText(name, args, false)).toContain(marker);
    });

    it(`${name} pending owns no trailing blank`, async () => {
      expect((await headerText(name, args, true)).endsWith("\n")).toBe(false);
    });

    it(`${name} settled ${settledBlank ? "keeps" : "skips"} its separator blank`, async () => {
      expect((await headerText(name, args, false)).endsWith("\n")).toBe(settledBlank);
    });
  }
});
