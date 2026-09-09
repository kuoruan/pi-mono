import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentPalette,
  FALLBACK_PALETTE,
  type PaletteTheme,
  resolveDiffPalette,
  resetPaletteForTest,
  setDiffRoots,
  themeCacheKey,
} from "#src/theme/palette.ts";
import {
  buildFakeTheme as fakeTheme,
  buildFakeTheme,
  resetPigmentForTest,
} from "#test/fixtures.ts";

/** A dark-theme success-bg escape (30,30,40). */
const DARK_BG_ESCAPE = "\x1b[48;2;30;30;40m";

// eslint-disable-next-line no-control-regex -- matches the SGR bg escape
const ANSI_BG_RE = /^\x1b\[48;2;\d+;\d+;\d+m$/;

describe("themeCacheKey", () => {
  it("distinguishes themes by diff-relevant colors", () => {
    expect(themeCacheKey(fakeTheme())).not.toBe(
      themeCacheKey(fakeTheme({ diffAdded: "\x1b[38;2;1;2;3m" })),
    );
    expect(themeCacheKey(fakeTheme({ successBg: "\x1b[48;2;9;9;9m" }))).not.toBe(
      themeCacheKey(fakeTheme()),
    );
  });

  it("keys a theme-less context deterministically", () => {
    expect(themeCacheKey(undefined)).toBe("no-theme");
    expect(themeCacheKey({} as PaletteTheme)).toBe("no-theme");
  });

  it("re-keys when the theme swaps BEHIND one object identity (pi's proxy shape)", () => {
    // Production hands every render the module-level Theme PROXY: pi's
    // setTheme swaps the underlying instance through globalThis while the
    // proxy object itself keeps a constant identity. The key must follow
    // the CONTENT — an identity-keyed memo would pin the first theme's
    // palette forever (the "diff body and stats chips stay recolored
    // after a /settings theme switch" report).
    const slots: Record<string, string> = {
      toolTitle: "\x1b[38;2;138;180;255m",
      accent: "\x1b[38;2;138;180;255m",
      muted: "\x1b[38;2;130;130;140m",
      dim: "\x1b[38;2;110;110;120m",
      success: "\x1b[38;2;100;200;120m",
      error: "\x1b[38;2;255;100;100m",
      toolDiffAdded: "\x1b[38;2;80;220;120m",
      toolDiffRemoved: "\x1b[38;2;240;90;90m",
      toolDiffContext: "\x1b[38;2;130;130;130m",
      toolSuccessBg: "\x1b[48;2;30;30;40m",
      toolErrorBg: "\x1b[48;2;40;30;30m",
    };
    const proxyLike = {
      fg: (name: string, text: string) => `${slots[name] ?? ""}${text}\x1b[0m`,
      bg: (name: string, text: string) => `${slots[name] ?? ""}${text}\x1b[0m`,
      getFgAnsi: (name: string) => slots[name] ?? "",
      getBgAnsi: (name: string) => slots[name] ?? "",
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    };
    const firstKey = themeCacheKey(proxyLike);
    const firstPalette = resolveDiffPalette(proxyLike);
    // The proxy object never changes; the instance behind it does.
    slots.toolDiffAdded = "\x1b[38;2;1;2;3m";
    slots.toolSuccessBg = "\x1b[48;2;250;250;250m";
    expect(themeCacheKey(proxyLike)).not.toBe(firstKey);
    const second = resolveDiffPalette(proxyLike);
    expect(second).not.toBe(firstPalette);
    expect(second.bgBase).toBe("\x1b[48;2;250;250;250m");
    expect(second.fgAdded).toBe("\x1b[38;2;1;2;3m");
  });
});

describe("resolveDiffPalette", () => {
  afterEach(() => {
    resetPaletteForTest();
  });

  it("returns the fallback palette for a theme-less context", () => {
    expect(resolveDiffPalette(undefined)).toBe(FALLBACK_PALETTE);
  });

  it("auto-derives backgrounds by blending diff fg into tool box bg", () => {
    const palette = resolveDiffPalette(fakeTheme());
    // add base = toolSuccessBg(30,30,40) blended 15% toward toolDiffAdded(80,220,120)
    expect(palette.bgAdded).toBe("\x1b[48;2;38;59;52m");
    // del base = toolErrorBg(40,30,30) blended 18% toward toolDiffRemoved(240,90,90)
    expect(palette.bgRemoved).toBe("\x1b[48;2;76;41;41m");
    expect(palette.bgBase).toBe("\x1b[48;2;30;30;40m");
    expect(palette.rowReset).toBe(`\x1b[0m\x1b[48;2;30;30;40m`);
    // word emphasis is a stronger blend of the same pair
    expect(palette.bgAddedWord).toBe("\x1b[48;2;45;87;64m");
  });

  it("uses the error background as the delete base when present", () => {
    const palette = resolveDiffPalette(fakeTheme({ errorBg: "\x1b[48;2;80;10;10m" }));
    // del base = (80,10,10) blended 18% toward (240,90,90)
    expect(palette.bgRemoved).toBe("\x1b[48;2;109;24;24m");
  });

  it("carries the theme's diff foregrounds", () => {
    const palette = resolveDiffPalette(fakeTheme());
    expect(palette.fgAdded).toBe("\x1b[38;2;80;220;120m");
    expect(palette.fgRemoved).toBe("\x1b[38;2;240;90;90m");
    expect(palette.fgContext).toBe("\x1b[38;2;130;130;130m");
  });

  it("flags light themes via the tool box background luminance", () => {
    expect(resolveDiffPalette(fakeTheme({ successBg: "\x1b[48;2;250;250;250m" })).isLight).toBe(
      true,
    );
    expect(resolveDiffPalette(fakeTheme({ successBg: "\x1b[48;2;20;20;30m" })).isLight).toBe(false);
  });

  it("re-derives the whole palette when the theme changes", () => {
    const first = resolveDiffPalette(fakeTheme());
    const second = resolveDiffPalette(
      fakeTheme({ diffAdded: "\x1b[38;2;1;2;3m", successBg: "\x1b[48;2;10;10;10m" }),
    );
    expect(second).not.toBe(first);
    expect(second.bgAdded).not.toBe(first.bgAdded);
    expect(second.bgBase).toBe("\x1b[48;2;10;10;10m");
    // resolving the original theme again re-derives the original palette
    const again = resolveDiffPalette(fakeTheme());
    expect(again.bgBase).toBe(first.bgBase);
    expect(again.bgAdded).toBe(first.bgAdded);
  });

  it("caches the snapshot between calls with the same theme", () => {
    const a = resolveDiffPalette(fakeTheme());
    const b = resolveDiffPalette(fakeTheme());
    expect(b).toBe(a);
  });
});

describe("palette unification (header/body consistency)", () => {
  afterEach(() => {
    resetPaletteForTest();
  });

  it("resolveDiffPalette refreshes the one snapshot every path reads", () => {
    const dark = fakeTheme();
    const light = fakeTheme({ successBg: "\x1b[48;2;250;250;250m" });

    // A render under dark, then a render under light — the singleton must
    // follow (background is the field that DIFFERS between the two themes;
    // a stale singleton would still serve the dark base).
    resolveDiffPalette(dark);
    expect(currentPalette().bgBase).toBe(resolveDiffPalette(dark).bgBase);
    resolveDiffPalette(light);
    const lightBody = resolveDiffPalette(light);
    expect(currentPalette()).toBe(lightBody); // same refreshed snapshot
    expect(lightBody.bgBase).toContain("250;250;250");
  });
});

describe("diff root overrides", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("replaces the derivation inputs and keeps the blend family consistent", () => {
    setDiffRoots({
      topLevel: { added: { text: "#ff8800" } },
    });
    const palette = resolveDiffPalette(buildFakeTheme());
    // fgAdded follows the root verbatim.
    expect(palette.fgAdded).toBe("\x1b[38;2;255;136;0m");
    // The canvas stays the theme's own (a root never replaces it).
    expect(palette.bgBase).not.toBe("\x1b[48;2;18;52;86m");
    // The blend family derives from the overridden inputs washed over
    // the theme canvas.
    expect(palette.bgAdded).toMatch(ANSI_BG_RE);
    expect(palette.bgAddedWord).toMatch(ANSI_BG_RE);
  });

  it("keeps fgCode on the theme-derived fg (a diff root restyles diffs, not file listings)", () => {
    setDiffRoots({
      topLevel: { added: { text: "#ff8800" } },
    });
    const palette = resolveDiffPalette(buildFakeTheme());
    // fgAdded follows the root; fgCode keeps the pi theme's toolDiffAdded
    // derivation — the slot's documented isolation.
    expect(palette.fgAdded).toBe("\x1b[38;2;255;136;0m");
    expect(palette.fgCode).not.toBe(palette.fgAdded);
    // Without a root override, both stay the theme-derived value.
    setDiffRoots(undefined);
    const plain = resolveDiffPalette(buildFakeTheme());
    expect(plain.fgCode).toBe(plain.fgAdded);
  });

  it("merges variant roots over top-level roots per key (polarity wins)", () => {
    setDiffRoots({
      topLevel: { added: { text: "#ff8800" }, removed: { text: "#ff0000" } },
      dark: { added: { text: "#00ff88" } },
    });
    const dark = resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG_ESCAPE }));
    expect(dark.fgAdded).toBe("\x1b[38;2;0;255;136m"); // dark variant wins
    expect(dark.fgRemoved).toBe("\x1b[38;2;255;0;0m"); // top-level survives
  });

  it("keeps isLight and the canvas on the pi theme's own background", () => {
    // Dark pi theme: polarity and canvas both stay the theme's — a root
    // cannot touch either (ADR 0006: the canvas is the pi theme's).
    setDiffRoots({ topLevel: { added: { text: "#ffffff" } } });
    const palette = resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG_ESCAPE }));
    expect(palette.isLight).toBe(false);
    expect(palette.bgBase).not.toBe("\x1b[48;2;255;255;255m");
  });

  it("derives muted chrome (fgDim/fgGutter) from the theme's dim/muted slots", () => {
    const theme = buildFakeTheme();
    const palette = resolveDiffPalette(theme);
    // dim slot → separators/more-lines; muted slot → line numbers.
    expect(palette.fgDim).toBe("\x1b[38;2;110;110;120m");
    expect(palette.fgGutter).toBe("\x1b[38;2;130;130;140m");
  });

  it("falls back to the fixed grays when the theme lacks dim/muted", () => {
    const theme: PaletteTheme = {
      fg: () => "",
      getFgAnsi: (name) => (name === "toolDiffAdded" ? "\x1b[38;2;80;220;120m" : ""),
      getBgAnsi: () => "\x1b[48;2;30;30;40m",
      bg: (_n, text) => text,
      bold: (text) => text,
    };
    const palette = resolveDiffPalette(theme);
    expect(palette.fgDim).toBe(FALLBACK_PALETTE.fgDim);
    expect(palette.fgGutter).toBe(FALLBACK_PALETTE.fgGutter);
  });

  it("re-derives when the roots spec changes under the same theme", () => {
    const theme = buildFakeTheme();
    resolveDiffPalette(theme);
    setDiffRoots({ topLevel: { added: { text: "#ff8800" } } });
    const palette = resolveDiffPalette(theme);
    expect(palette.fgAdded).toBe("\x1b[38;2;255;136;0m");
  });
});

describe("translucent tint roots (ADR 0003 tint anchoring)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("anchors the word slot and scales the ladder — the canvas stays untouched", () => {
    // github-dark's word tint: #3fb950 at alpha 0x4d (77/255) over the
    // canvas. mixBg(base, tint, alpha) IS the composite.
    setDiffRoots({ topLevel: { added: { tint: "#3fb9504d" } } });
    const palette = resolveDiffPalette(buildFakeTheme());
    // Word slot = the exact composite: mix((30,30,40), (63,185,80), 77/255).
    const a = 77 / 255;
    const expectedWord = {
      r: Math.round(30 + (63 - 30) * a),
      g: Math.round(30 + (185 - 30) * a),
      b: Math.round(40 + (80 - 40) * a),
    };
    expect(palette.bgAddedWord).toBe(
      `\x1b[48;2;${expectedWord.r};${expectedWord.g};${expectedWord.b}m`,
    );
    // Line = alpha × (0.15/0.30) = alpha/2; gutter = alpha/3.
    const lineA = a * 0.5;
    const expectedLine = {
      r: Math.round(30 + (63 - 30) * lineA),
      g: Math.round(30 + (185 - 30) * lineA),
      b: Math.round(40 + (80 - 40) * lineA),
    };
    expect(palette.bgAdded).toBe(
      `\x1b[48;2;${expectedLine.r};${expectedLine.g};${expectedLine.b}m`,
    );
    // The canvas (background, context rows) stays the pi theme's own.
    expect(palette.bgBase).toBe("\x1b[48;2;30;30;40m");
    expect(palette.rowReset).toBe(`\x1b[0m\x1b[48;2;30;30;40m`);
  });

  it("composes a tint over the theme's own canvas (the canvas is never a root)", () => {
    // ADR 0006: the tint anchors over the pi theme's canvas — the add
    // side's canvas is toolSuccessBg (30,30,40 in the fake theme).
    setDiffRoots({ topLevel: { added: { tint: "#3fb95080" } } });
    const palette = resolveDiffPalette(buildFakeTheme());
    expect(palette.bgBase).toBe("\x1b[48;2;30;30;40m"); // the theme's canvas
    // Word = mix((30,30,40), (63,185,80), 0x80/255); line = α×(0.15/0.3).
    const a = 0x80 / 255;
    const word = {
      r: Math.round(30 + (63 - 30) * a),
      g: Math.round(30 + (185 - 30) * a),
      b: Math.round(40 + (80 - 40) * a),
    };
    expect(palette.bgAddedWord).toBe(`\x1b[48;2;${word.r};${word.g};${word.b}m`);
    expect(palette.bgAdded).toBe(
      `\x1b[48;2;${Math.round(30 + (63 - 30) * a * 0.5)};${Math.round(30 + (185 - 30) * a * 0.5)};${Math.round(40 + (80 - 40) * a * 0.5)}m`,
    );
  });

  it("anchors the del side over the del canvas with its own ladder", () => {
    setDiffRoots({ topLevel: { removed: { tint: "#f8514966" } } });
    const palette = resolveDiffPalette(buildFakeTheme());
    // Del canvas = toolErrorBg (40,30,30); word slot = composite at 0x66.
    const a = 0x66 / 255;
    const expected = {
      r: Math.round(40 + (248 - 40) * a),
      g: Math.round(30 + (81 - 30) * a),
      b: Math.round(30 + (73 - 30) * a),
    };
    expect(palette.bgRemovedWord).toBe(`\x1b[48;2;${expected.r};${expected.g};${expected.b}m`);
    // Line slot = alpha × (0.18/0.35).
    const lineA = a * (0.18 / 0.35);
    const expectedLine = {
      r: Math.round(40 + (248 - 40) * lineA),
      g: Math.round(30 + (81 - 30) * lineA),
      b: Math.round(30 + (73 - 30) * lineA),
    };
    expect(palette.bgRemoved).toBe(
      `\x1b[48;2;${expectedLine.r};${expectedLine.g};${expectedLine.b}m`,
    );
    // The row canvas is NOT the tint.
    expect(palette.bgBase).toBe("\x1b[48;2;30;30;40m");
  });

  it("applies per side (inserted tint alone leaves the del family derived)", () => {
    setDiffRoots({ topLevel: { added: { tint: "#3fb9504d" } } });
    const palette = resolveDiffPalette(buildFakeTheme());
    // The del family keeps the pi-derived value (18% toward toolDiffRemoved).
    expect(palette.bgRemoved).toBe("\x1b[48;2;76;41;41m");
  });

  it("ignores translucent FOREGROUND roots (fgs are never composited)", () => {
    setDiffRoots({ topLevel: { added: { text: "#ff88004d" } } });
    const palette = resolveDiffPalette(buildFakeTheme());
    // The theme's own fg survives; the translucent root is meaningless.
    expect(palette.fgAdded).toBe("\x1b[38;2;80;220;120m");
  });

  it("judges polarity contradictions on the composited color, not the raw tint", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A LIGHT hue at a FAINT alpha over a dark canvas composites dark —
      // no contradiction, no warning.
      setDiffRoots({ topLevel: { added: { tint: "#ffffff26" } } });
      resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG_ESCAPE }));
      expect(errorSpy).not.toHaveBeenCalled();

      // A near-opaque light tint over the dark canvas composites light —
      // contradiction, one warning.
      setDiffRoots({ topLevel: { added: { tint: "#ffffffe6" } } });
      resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG_ESCAPE }));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/contradict/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("roots never touch the canvas (ADR 0006: the canvas is the pi theme's)", () => {
    setDiffRoots({ topLevel: { added: { text: "#123456" } } });
    const palette = resolveDiffPalette(buildFakeTheme());
    // The fake theme's toolSuccessBg (30,30,40), not any root.
    expect(palette.bgBase).toBe("\x1b[48;2;30;30;40m");
  });
});
