import { describe, expect, it } from "vitest";

import { iterateCells } from "#src/core/ansi.ts";

/**
 * Collect a string's cells for assertions.
 *
 * @param s - The string to walk.
 * @returns The cells, left to right.
 */
const cells = (s: string) => [...iterateCells(s)];

describe("iterateCells (the styled-text walk primitive)", () => {
  it("yields plain ASCII one cell per character with one column each", () => {
    const out = cells("abc");
    expect(out.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(out.every((c) => c.cols === 1 && c.chars === 1 && !c.escape)).toBe(true);
    expect(out[0]).toMatchObject({ start: 0, end: 1 });
    expect(out[2]).toMatchObject({ start: 2, end: 3 });
  });

  it("yields SGR escapes whole: zero columns, zero characters", () => {
    const out = cells("\x1b[38;2;1;2;3mA\x1b[39mB");
    expect(out.map((c) => c.text)).toEqual(["\x1b[38;2;1;2;3m", "A", "\x1b[39m", "B"]);
    expect(out[0]).toMatchObject({ cols: 0, chars: 0, escape: true, start: 0, end: 13 });
    expect(out[2]).toMatchObject({ escape: true });
  });

  it("counts East-Asian wide code points as two columns (one character)", () => {
    const out = cells("漢x");
    expect(out[0]).toMatchObject({ text: "漢", cols: 2, chars: 1, start: 0, end: 1 });
    expect(out[1]).toMatchObject({ text: "x", cols: 1, start: 1, end: 2 });
  });

  it("counts regional indicators (flags) as two columns", () => {
    // U+1F1FA U+1F1F8 (🇺🇸): two surrogate pairs, two cells, 2 columns each.
    const out = cells("🇺🇸");
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.cols === 2 && c.end - c.start === 2)).toBe(true);
  });

  it("yields astral code points (emoji) as single cells with surrogate spans", () => {
    const out = cells("👍");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cols: 2, chars: 1, start: 0, end: 2 });
  });

  it("a lone ESC without a terminator falls back to a code point cell", () => {
    const out = cells("a\x1bZ");
    expect(out.map((c) => c.text)).toEqual(["a", "\x1b", "Z"]);
    expect(out[1]!.escape).toBe(false);
  });

  it("empty string yields nothing", () => {
    expect(cells("")).toEqual([]);
  });

  it("spans tile the input exactly (no gaps, no overlaps)", () => {
    const s = "a漢\x1b[1m👍\x1b[0m";
    const out = cells(s);
    let at = 0;
    for (const c of out) {
      expect(c.start).toBe(at);
      at = c.end;
    }
    expect(at).toBe(s.length);
    // Reassembly is identity.
    expect(out.map((c) => c.text).join("")).toBe(s);
  });

  it("yields OSC-8 hyperlinks whole: an 'm' inside the URL never splits the sequence", () => {
    // The tool-header link shape: OSC 8 open + URL (containing 'm' via
    // /tmp/) + ST, then the VISIBLE label as code-point cells, then the
    // OSC 8 close. The 'm'-to-'m' SGR scan used to cut the sequence at
    // the URL's first 'm', mis-measuring the row and corrupting the link
    // bytes downstream (reinjectSgr dropped the ST's ESC — the pi-tui
    // width-assert crash).
    const open = "\x1b]8;;file:///tmp/pi-196/src.ts\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    const input = `← edit ${open}src.ts${close} done`;
    const out = cells(input);
    expect(out.map((c) => c.text)).toEqual([
      "←",
      " ",
      "e",
      "d",
      "i",
      "t",
      " ",
      open,
      "s",
      "r",
      "c",
      ".",
      "t",
      "s",
      close,
      " ",
      "d",
      "o",
      "n",
      "e",
    ]);
    const osc = out[7]!;
    expect(osc).toMatchObject({ escape: true, cols: 0, chars: 0, start: 7, end: 7 + open.length });
    // The close is an escape cell too (zero columns).
    expect(out[14]).toMatchObject({ escape: true, cols: 0, chars: 0 });
    // Reassembly stays identity.
    expect(out.map((c) => c.text).join("")).toBe(input);
  });

  it("yields BEL-terminated OSC sequences whole too", () => {
    const open = "\x1b]8;;file:///x/y\u0007";
    const close = "\x1b]8;;\u0007";
    const out = cells(`a${open}lb${close}c`);
    expect(out.map((c) => c.text)).toEqual(["a", open, "l", "b", close, "c"]);
    expect(out[1]).toMatchObject({ escape: true, cols: 0, chars: 0 });
    expect(out[4]).toMatchObject({ escape: true, cols: 0, chars: 0 });
  });

  it("an unterminated OSC falls back to the lone-ESC code point cell", () => {
    const out = cells("a\x1b]8;;file:///no-terminator");
    // The open ESC has no BEL/ST ahead: code-point cells from there on,
    // tiling intact.
    expect(out.map((c) => c.text).join("")).toBe("a\x1b]8;;file:///no-terminator");
    expect(out[1]!.text).toBe("\x1b");
    expect(out[1]!.escape).toBe(false);
  });
});
