/** Pure color math: ANSI-color decoding and WCAG measures. */

import { describe, expect, it } from "vitest";

import {
  isAlphaHex8,
  isLightRgb,
  isOpaqueHex6,
  parseAnsiRgb,
  parseHexForm,
  parseOpaqueHex,
  parseRootColor,
  rgbLuminance,
} from "#src/core/color.ts";

describe("parseAnsiRgb", () => {
  it("parses truecolor fg sequences", () => {
    expect(parseAnsiRgb("\x1b[38;2;10;20;30m")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("parses truecolor bg sequences", () => {
    expect(parseAnsiRgb("\x1b[48;2;1;2;3m")).toEqual({ r: 1, g: 2, b: 3 });
  });

  it("decodes 256-color sequences through the XTerm cube and grayscale", () => {
    // Cube corners.
    expect(parseAnsiRgb("\x1b[38;5;16m")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseAnsiRgb("\x1b[48;5;231m")).toEqual({ r: 255, g: 255, b: 255 });
    // A mid-cube color: 59 = 16 + 1*36 + 1*6 + 1 → (95,95,95).
    expect(parseAnsiRgb("\x1b[38;5;59m")).toEqual({ r: 95, g: 95, b: 95 });
    // Grayscale ramp: 232 → 8, 255 → 238.
    expect(parseAnsiRgb("\x1b[38;5;232m")).toEqual({ r: 8, g: 8, b: 8 });
    expect(parseAnsiRgb("\x1b[38;5;255m")).toEqual({ r: 238, g: 238, b: 238 });
  });

  it("rejects system colors, malformed input, and plain text", () => {
    // 0-15 are terminal-configured system colors with no portable RGB.
    expect(parseAnsiRgb("\x1b[38;5;0m")).toBeNull();
    expect(parseAnsiRgb("\x1b[38;5;15m")).toBeNull();
    expect(parseAnsiRgb("\x1b[38;5;256m")).toBeNull();
    expect(parseAnsiRgb("\x1b[31m")).toBeNull(); // 16-color code
    expect(parseAnsiRgb("plain")).toBeNull();
    expect(parseAnsiRgb("")).toBeNull();
  });
});

describe("rgbLuminance / isLightRgb", () => {
  it("uses the WCAG relative luminance formula", () => {
    expect(rgbLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(rgbLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it("classifies light vs dark at the 0.5 threshold", () => {
    expect(isLightRgb({ r: 255, g: 255, b: 255 })).toBe(true);
    expect(isLightRgb({ r: 0, g: 0, b: 0 })).toBe(false);
    // Mid-gray linearizes to ~0.216 — dark by the WCAG formula.
    expect(isLightRgb({ r: 128, g: 128, b: 128 })).toBe(false);
    expect(isLightRgb({ r: 188, g: 188, b: 188 })).toBe(true);
  });
});

describe("parseRootColor (root hex with 3/4-digit shorthand)", () => {
  it("expands #rgb to its 6-digit form (opaque)", () => {
    expect(parseRootColor("#3af")).toEqual({
      rgb: { r: 51, g: 170, b: 255 },
      alpha: 1,
    });
  });

  it("expands #rgba to its 8-digit form, doubling each channel", () => {
    const root = parseRootColor("#3af6");
    expect(root?.rgb).toEqual({ r: 51, g: 170, b: 255 });
    expect(root?.alpha).toBeCloseTo(102 / 255, 5);
  });

  it("keeps accepting the full 6/8-digit forms", () => {
    expect(parseRootColor("#3fa9f5")).toEqual({
      rgb: { r: 63, g: 169, b: 245 },
      alpha: 1,
    });
    expect(parseRootColor("#3fa9f566")?.alpha).toBeCloseTo(102 / 255, 5);
  });

  it("rejects everything else (2/5-digit, wrong chars, names)", () => {
    expect(parseRootColor("#3a")).toBeNull();
    expect(parseRootColor("#3a4bc")).toBeNull();
    expect(parseRootColor("#3a4b5c7d8")).toBeNull();
    expect(parseRootColor("#ggg")).toBeNull();
    expect(parseRootColor("red")).toBeNull();
  });
});

describe("parseHexForm strictness (TinyColor's lenience never leaks)", () => {
  it("requires the # prefix and rejects surrounding whitespace", () => {
    expect(parseHexForm("fff")).toBeNull(); // TinyColor alone accepts this
    expect(parseHexForm("#fff ")).toBeNull(); // trailing whitespace
    expect(parseHexForm(" #fff")).toBeNull(); // leading whitespace
    expect(parseHexForm("#fff")).not.toBeNull();
  });

  it("classifies the alpha forms", () => {
    expect(parseHexForm("#fff")?.isAlphaForm).toBe(false);
    expect(parseHexForm("#ffffff")?.isAlphaForm).toBe(false);
    expect(parseHexForm("#ffff")?.isAlphaForm).toBe(true);
    expect(parseHexForm("#ffffffff")?.isAlphaForm).toBe(true);
  });

  it("rejects non-hex color syntaxes (names, rgb(), hsl())", () => {
    expect(parseHexForm("red")).toBeNull();
    expect(parseHexForm("rgb(255,0,0)")).toBeNull();
    expect(parseHexForm("hsl(0,100%,50%)")).toBeNull();
  });
});

describe("isOpaqueHex6 / isAlphaHex8 (exact-form predicates)", () => {
  it("accepts exactly the 6-digit opaque form", () => {
    expect(isOpaqueHex6("#ffffff")).toBe(true);
    expect(isOpaqueHex6("#fff")).toBe(false); // shorthand is not exact
    expect(isOpaqueHex6("#ffffffff")).toBe(false); // alpha form
    expect(isOpaqueHex6("#ffff")).toBe(false);
  });

  it("accepts exactly the 8-digit alpha form", () => {
    expect(isAlphaHex8("#ffffffff")).toBe(true);
    expect(isAlphaHex8("#ffff")).toBe(false); // shorthand is not exact
    expect(isAlphaHex8("#ffffff")).toBe(false); // opaque form
    expect(isAlphaHex8("#fff")).toBe(false);
  });
});

describe("parseOpaqueHex", () => {
  it("expands the 3-digit shorthand and passes regeneration forms through", () => {
    expect(parseOpaqueHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOpaqueHex("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOpaqueHex("#ffff")).toBeNull(); // 4-digit is not opaque shorthand
    expect(parseOpaqueHex("#ffffffff")).toBeNull(); // 8-digit is not opaque shorthand
  });
});
