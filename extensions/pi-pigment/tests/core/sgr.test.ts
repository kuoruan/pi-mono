/**
 * ReinjectSgr (the bg re-injection scanner) on real-world styled lines:
 * reset injections stay exact while non-SGR escapes — above all the OSC-8
 * hyperlinks tool headers carry — pass through with every byte intact.
 */

import { describe, expect, it } from "vitest";

import { reinjectSgr } from "#src/core/sgr.ts";
import { injectBg } from "#src/render/inject-bg.ts";

const BG = "\x1b[48;2;30;30;40m";

describe("reinjectSgr (reset re-injection vs non-SGR sequences)", () => {
  it("re-injects after each reset-like SGR and leaves others alone", () => {
    const input = `a\x1b[39mb\x1b[0mc\x1b[49md\x1b[38;2;1;2;3me`;
    expect(reinjectSgr(input, BG, input.indexOf("\x1b"))).toBe(
      `a\x1b[39m${BG}b\x1b[0m${BG}c\x1b[49m${BG}d\x1b[38;2;1;2;3me`,
    );
    // Non-reset SGR never injects.
    expect(reinjectSgr(`a\x1b[1mb`, BG, 1)).toBe(`a\x1b[1mb`);
  });

  it("an OSC-8 hyperlink passes through byte-for-byte (an 'm' in the URL is not an SGR end)", () => {
    // The regression: the URL's first 'm' (…/tmp/…) ended the SGR scan,
    // the ST's ESC byte was dropped, and the corrupted link poisoned every
    // width measured over the row (the pi-tui hard-assert crash).
    const url = "file:///tmp/pi-196/src.ts";
    const link = `\x1b]8;;${url}\x1b\\src.ts\x1b]8;;\x1b\\`;
    const input = `← edit ${link}\x1b[39m tail`;
    const output = reinjectSgr(input, BG, input.indexOf("\x1b"));
    // The link survives exactly, including BOTH ST terminators' ESC bytes.
    expect(output).toContain(link);
    expect(output).toBe(`← edit ${link}\x1b[39m${BG} tail`);
  });

  it("a BEL-terminated OSC passes through whole", () => {
    const seq = "\x1b]8;;file:///x/y\x07";
    const input = `a${seq}\x1b[0mb`;
    expect(reinjectSgr(input, BG, input.indexOf("\x1b"))).toBe(`a${seq}\x1b[0m${BG}b`);
  });

  it("a lone ESC survives as a byte (code-point semantics, no loss)", () => {
    // \x1bZ: ESC followed by a non-[ non-] char — the walk copies the ESC
    // byte itself and continues scanning past it.
    expect(reinjectSgr("a\x1bZb\x1b[0mc", BG, 1)).toBe(`a\x1bZb\x1b[0m${BG}c`);
  });
});

describe("injectBg on hyperlinked rows (the setCallHeader bg painter)", () => {
  it("wraps a styled header row with a hyperlink without corrupting the link or the width", () => {
    const url = "file:///workspace/pi-mono/extensions/pi-pigment/src/render/render-shared.ts";
    const link = `\x1b]8;;${url}\x1b\\extensions/pi-pigment/src/render/render-shared.ts\x1b]8;;\x1b\\`;
    const line = `\x1b[1m← edit\x1b[22m ${link}`;
    const out = injectBg(line, { baseBg: BG });
    // The hyperlink's escape bytes are intact.
    expect(out).toContain(link);
    // The wrap shape: base bg, line (with the reinjection pass), row reset.
    expect(out.startsWith(BG)).toBe(true);
    // No injection inside the OSC: the only BG occurrences are the wrap's
    // own openings/closings — count them: prefix + rowEnd reopenings.
    const bgCount = out.split(BG).length - 1;
    expect(bgCount).toBeGreaterThanOrEqual(2);
    const afterLink = out.slice(out.indexOf(link) + link.length);
    expect(afterLink.startsWith(`\x1b[39m`)).toBe(false);
  });
});
