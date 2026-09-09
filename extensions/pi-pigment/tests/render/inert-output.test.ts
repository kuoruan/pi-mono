import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseDiff, sepLabel } from "#src/core/diff.ts";
import { formatToolErrorResult } from "#src/render/error-frame.ts";
import { formatToolHeaderPath } from "#src/render/header.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { renderPlainTextFallback } from "#src/render/tool-factory.ts";
import { parseHitLine } from "#src/render/tool-grep.ts";
import { FALLBACK_PALETTE } from "#src/theme/palette.ts";
import {
  buildRenderTheme,
  makeRenderCtx,
  makeTextComponent,
  plain,
  registerTools,
  waitFor,
  type DrivenTaskComponent,
  type TextDouble,
} from "#test/fixtures.ts";

// REAL fs (not memfs): these tests EXECUTE the SDK's grep/find tools,
// whose own directory scanners bypass node:fs — only a real temp dir
// feeds them.
const tempDir = mkdtempSync(join(tmpdir(), "pi-pigment-inert-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/**
 * The ADR 0004 property: rendered output may contain ESC sequences from OUR
 * chrome only — SGR (`ESC[...m`) and the OSC-8 file-link wrap (its opening
 * `ESC]8;;<url>`, the ST terminator `ESC\`, and the closing empty segment;
 * the URL is pathToFileURL-encoded, so user bytes cannot become control
 * sequences inside it). User data can contribute glyphs, never sequence
 * introducers.
 */
// eslint-disable-next-line no-control-regex -- intentionally matches control chars
const NON_SGR_ESCAPE = /\x1b(?!\[[\d;]*m|\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)|\\)/;

describe("inert output property (ADR 0004)", () => {
  it("defuses OSC 52 clipboard-write payloads in diffed file content", async () => {
    // A file line carrying an OSC 52 clipboard-write payload plus a CSI
    // cursor-reposition — the two classic terminal-injection vectors.
    const malicious = "print('\x1b]52;c;AAAAAA\x07\x1b[5;10H')\n";
    const diff = parseDiff(malicious, `${malicious}x = 1;\n`, 3);
    const out = await renderUnified({
      diff,
      language: undefined,
      maxLines: 40,
      width: 120,
      palette: FALLBACK_PALETTE,
      indicator: "bar",
    });
    expect(NON_SGR_ESCAPE.test(out)).toBe(false);
    // The payload is visible, not hidden: honest display of what the file holds.
    expect(out).toContain("^[]52;c;AAAAAA^G^[[5;10H");
  });

  it("defuses OSC 52 payloads in grep hit content and paths", () => {
    const parsed = ["evil\x1b]52;c;AAAA\x07.ts:12: content\x1b]52;c;BBBB\x07 here"].map((line) =>
      parseHitLine(line),
    );
    const hit = parsed[0];
    expect(hit).not.toBeNull();
    expect(hit?.prefix).toBe("evil^[]52;c;AAAA^G.ts:12:");
    expect(hit?.content).toBe("content^[]52;c;BBBB^G here");
  });

  it("CR in content renders as ^M, never a column-0 return (CRLF files)", async () => {
    // CRLF content: the trailing CR must not survive to move the cursor —
    // today's rendering keeps the gutter intact instead of overwriting it.
    const diff = parseDiff("a\r\n", "b\r\n", 3);
    const out = await renderUnified({
      diff,
      language: undefined,
      maxLines: 40,
      width: 80,
      palette: FALLBACK_PALETTE,
      indicator: "bar",
    });
    expect(NON_SGR_ESCAPE.test(out)).toBe(false);
    expect(out).toContain("^M");
  });

  it("defuses payloads in the grep placeholder/fallback first frame (intake inert)", async () => {
    // The swap protocol's first frame shows the placeholder synchronously
    // and the fallback permanently on render failure — both must consume
    // intake-inerted text, not raw file bytes.
    const tools = await registerTools();
    const grep = tools.find((t) => t.name === "grep");
    if (!grep?.renderResult) throw new Error("grep not registered");
    const malicious = "const a = '\x1b]52;c;AAAAAA\x07';";
    writeFileSync(join(tempDir, "evil.ts"), `${malicious}\n`);
    const result = await grep.execute(
      "t1",
      { pattern: "a = ", path: tempDir },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "a = " };
    const component = grep.renderResult(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    component.render(120); // the placeholder frame, synchronously
    const placeholder = plain(component.text.text);
    expect(NON_SGR_ESCAPE.test(placeholder)).toBe(false);
    expect(placeholder).toContain("^[]52;c;AAAAAA^G");
    // And the fallback text (the protocol's failure surface) is the same
    // inerted plain form.
    const task = (component as TextDouble).previewTask;
    expect(task?.fallback).toBeDefined();
    expect(NON_SGR_ESCAPE.test(plain(task!.fallback))).toBe(false);
  });

  it("defuses payloads in the error frame (stderr embeds the pattern verbatim)", () => {
    const frame = formatToolErrorResult({
      name: "grep",
      message: `rg: regex parse error: '\x1b]52;c;AAAAAA\x07(' unclosed group`,
      theme: buildRenderTheme(),
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(NON_SGR_ESCAPE.test(frame)).toBe(false);
    expect(frame).toContain("^[]52;c;AAAAAA^G");
  });

  it("badges the shell exit status into the error frame's header", () => {
    const theme = buildRenderTheme();
    // Plain non-zero exit: ✗ N, error-colored.
    const frame = formatToolErrorResult({
      name: "bash",
      message: `ls: cannot access 'x': No such file or directory\n\nCommand exited with code 2`,
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(frame).toContain("✗ exit 2");
    // The signal range (128-255) earns the sig label and warning color.
    const signal = formatToolErrorResult({
      name: "bash",
      message: "output\n\nCommand exited with code 143",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(signal).toContain("✗ exit 143");
    // Timeout and abort carry their own statuses.
    const timeout = formatToolErrorResult({
      name: "bash",
      message: "partial output\n\nCommand timed out after 30 seconds",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(timeout).toContain("✗ timeout 30s");
    const aborted = formatToolErrorResult({
      name: "bash",
      message: "Command aborted",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(aborted).toContain("aborted");
    // Non-shell tools never badge (no exit-code semantics).
    const write = formatToolErrorResult({
      name: "write",
      message: "File content is required",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(write).not.toContain("✗");
  });

  it("marks the error body with the ▌ bar (warning for signal/timeout kinds)", () => {
    const theme = buildRenderTheme();
    const errorFrame = formatToolErrorResult({
      name: "bash",
      message: "boom\n\nCommand exited with code 1",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(errorFrame).toMatch(/▌ boom/);
    const signalFrame = formatToolErrorResult({
      name: "bash",
      message: "boom\n\nCommand exited with code 130",
      theme,
      pathShortener: (p: string) => p,
      expanded: false,
      indicatorStyle: "bar",
      width: 120,
    });
    expect(signalFrame).toMatch(/▌ boom/);
  });
  it("defuses payloads in tool header paths (model-produced path)", () => {
    const styled = formatToolHeaderPath(
      buildRenderTheme(),
      "src/evil\x1b]52;c;AAAAAA\x07.ts",
      (p) => p,
    );
    expect(NON_SGR_ESCAPE.test(styled)).toBe(false);
    expect(styled).toContain("^[]52;c;AAAAAA^G");
  });

  it("defuses payloads in the plain-text fallback (result text embeds paths)", () => {
    const fakeResult = {
      content: [
        { type: "text", text: "Successfully wrote 3 bytes to /tmp/evil\x1b]52;c;AAAAAA\x07.ts" },
      ],
    };
    const text = makeTextComponent();
    renderPlainTextFallback(text as never, buildRenderTheme(), fakeResult as never);
    const out = plain((text as TextDouble).text.text);
    expect(NON_SGR_ESCAPE.test(out)).toBe(false);
    expect(out).toContain("^[]52;c;AAAAAA^G");
  });

  it("defuses payloads in a bracketed find truncation-lookalike filename", async () => {
    // A file literally named to open like the SDK notice — the branch
    // must inert it, and the shape check must not mistake it for a
    // notice (no warning styling for ordinary bracketed names).
    const evil = join(tempDir, "[Truncated:\x1b]52;c;AAAAAA\x07].md");
    writeFileSync(evil, "x\n");
    const tools = await registerTools({ cwd: tempDir });
    const find = tools.find((t) => t.name === "find");
    if (!find?.renderResult) throw new Error("find not registered");
    const result = await find.execute(
      "t1",
      { pattern: "*.md", path: tempDir },
      undefined,
      undefined,
      undefined,
    );
    const { ctx } = makeRenderCtx();
    ctx.args = { pattern: "*.md" };
    const component = find.renderResult(
      result,
      { expanded: false, isPartial: false },
      buildRenderTheme(),
      ctx,
    ) as DrivenTaskComponent;
    component.render(120);
    await waitFor(() => (plain(component.text.text).includes("].md") ? true : undefined));
    const out = plain(component.text.text);
    expect(NON_SGR_ESCAPE.test(out)).toBe(false);
    expect(out).toContain("^[]52;c;AAAAAA^G");
  });

  it("keeps hunk function-context sep labels inert (defense in depth)", () => {
    const label = sepLabel(
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        context: "function evil()\x1b]52;c;AAAAAA\x07",
      },
      3,
    );
    expect(NON_SGR_ESCAPE.test(label)).toBe(false);
    expect(label).toContain("^[]52;c;AAAAAA^G");
  });
});
