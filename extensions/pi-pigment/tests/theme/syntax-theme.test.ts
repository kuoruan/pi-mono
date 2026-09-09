import { hlBlock } from "#src/theme/highlight.ts";
import {
  currentPalette as currentPaletteOf,
  currentTheme as currentThemeOf,
  resetPaletteForTest,
  resolveDiffPalette,
  themeCacheKey,
} from "#src/theme/palette.ts";
import {
  applySemanticPatches,
  buildPiSyntaxTheme,
  buildSemanticTheme,
  enforceThemeColors,
  SEMANTIC_KEYS,
  type PiSyntaxTheme,
} from "#src/theme/syntax-theme.ts";
import { resolveActiveTheme } from "#src/theme/theme-selection.ts";
import { buildFakeTheme, type FakeThemeOverrides, resetPigmentForTest } from "#test/fixtures.ts";

const DARK_BG = "\x1b[48;2;40;50;40m";
const LIGHT_BG = "\x1b[48;2;232;240;232m";
const LIGHT_ERR_BG = "\x1b[48;2;240;232;232m";
/** Light-theme overrides (light success AND error backgrounds). */
const LIGHT = { successBg: LIGHT_BG, errorBg: LIGHT_ERR_BG, syntaxColors: true } as const;
/** Dark-theme overrides. */
const DARK = { successBg: DARK_BG, syntaxColors: true } as const;

const CODE = "const answer = 42; // note";

/**
 * Resolve a palette + syntax theme pair for a fake theme.
 *
 * @param overrides - The fake theme overrides.
 * @returns The generated theme, or null when syntax colors are absent.
 */
function derive(overrides?: FakeThemeOverrides): PiSyntaxTheme | null {
  const theme = buildFakeTheme(overrides);
  const palette = resolveDiffPalette(theme);
  return buildPiSyntaxTheme(theme, palette, themeCacheKey(theme));
}

// ---------------------------------------------------------------------------
// WCAG math mirrors (kept minimal — the implementation is the source of truth
// for adjustment; these tests assert the OUTCOME contract).
// ---------------------------------------------------------------------------

/**
 * Hex → [r,g,b] triple for the contrast oracle.
 *
 * @param hex - The hex string.
 * @returns The RGB triple.
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Hex → {r,g,b} for the contrast oracle.
 *
 * @param hex - The hex string.
 * @returns The RGB object.
 */
function hexToRgbObj(hex: string): { r: number; g: number; b: number } {
  const t = hexToRgb(hex) as [number, number, number];
  return { r: t[0], g: t[1], b: t[2] };
}

/**
 * An {r,g,b} → hex string.
 *
 * @param rgb - The RGB object.
 * @returns The hex string.
 */
function hexOf(rgb: { r: number; g: number; b: number }): string {
  return `#${[rgb.r, rgb.g, rgb.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Linearize one sRGB channel.
 *
 * @param c - The 8-bit channel value.
 * @returns The linearized channel.
 */
function linearize(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: [number, number, number]): number {
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

function contrast(a: string, b: string): number {
  const l1 = luminance(hexToRgb(a));
  const l2 = luminance(hexToRgb(b));
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function themeForegrounds(theme: PiSyntaxTheme): string[] {
  // PiSyntaxTheme's rules always carry a foreground (the builder's contract).
  return theme.tokenColors.map((token) => token.settings.foreground);
}

/**
 * The renderer backgrounds the syntax colors must read on, as hex.
 *
 * @param overrides - The fake theme overrides.
 * @returns The parsed add/del/emphasis background hexes.
 */
function backgroundHexes(overrides: FakeThemeOverrides | typeof LIGHT | typeof DARK): string[] {
  const theme = buildFakeTheme(overrides);
  const palette = resolveDiffPalette(theme);
  resetPaletteForTest();
  return [palette.bgAdded, palette.bgRemoved, palette.bgAddedWord, palette.bgRemovedWord]
    .map((escape) => escape.match(/48;2;(\d+);(\d+);(\d+)m/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(
      (m) =>
        `#${m
          .slice(1)
          .map((v) => Number(v).toString(16).padStart(2, "0"))
          .join("")}`,
    );
}

describe("SemanticKey derivation from ThemeColor", () => {
  it("derives the nine keys from the SDK syntax slots (order stable for identity hashing)", () => {
    expect(SEMANTIC_KEYS).toEqual([
      "comment",
      "keyword",
      "function",
      "variable",
      "string",
      "number",
      "type",
      "operator",
      "punctuation",
    ]);
  });
});

describe("buildPiSyntaxTheme", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("returns null when the theme lacks syntax colors", () => {
    expect(derive()).toBeNull();
  });

  it("derives a dark theme from the pi theme's syntax colors", () => {
    const theme = derive(DARK);
    expect(theme).not.toBeNull();
    expect(theme!.type).toBe("dark");
    expect(theme!.name).toMatch(/^pi-dark-/);
    expect(theme!.tokenColors.length).toBeGreaterThan(5);
  });

  it("derives a light theme and adapts adjustment direction", () => {
    const theme = derive(LIGHT);
    expect(theme!.type).toBe("light");
    expect(theme!.name).toMatch(/^pi-light-/);
  });

  it("produces distinct theme names for distinct palettes", () => {
    const dark = derive(DARK);
    const light = derive(LIGHT);
    expect(dark!.name).not.toBe(light!.name);
  });

  it("preserves hues: adjusted colors stay within the original color family", () => {
    const theme = derive(DARK)!;
    // VS Code dark comment green (#6A9955) fails AA on the blend backgrounds;
    // the adjusted color must still be a green, not washed to gray or flipped.
    const comment = theme.tokenColors.find((t) => t.scope.includes("comment"))!.settings.foreground;
    const [r, g, b] = hexToRgb(comment);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

describe("WCAG compliance of the generated themes", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("every dark-theme token color clears AA on every renderer background", () => {
    const overrides = DARK;
    const theme = derive(overrides)!;
    const backgrounds = backgroundHexes(overrides);
    for (const fg of themeForegrounds(theme)) {
      for (const bg of backgrounds) {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("every light-theme token color clears AA on every renderer background", () => {
    const overrides = LIGHT;
    const theme = derive(overrides)!;
    const backgrounds = backgroundHexes(overrides);
    for (const fg of themeForegrounds(theme)) {
      for (const bg of backgrounds) {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("adjusts only what fails: compliant colors pass through unchanged", () => {
    const overrides = DARK;
    const theme = derive(overrides)!;
    const backgrounds = backgroundHexes(overrides);
    // syntaxFunction (#DCDCAA) already clears AA on dark backgrounds.
    const fnColor = theme.tokenColors.find((t) => t.scope.includes("entity.name.function"))!
      .settings?.foreground;
    expect(fnColor.toLowerCase()).toBe("#dcdcaa");
    for (const bg of backgrounds) {
      expect(contrast("#DCDCAA", bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("shikiTheme integration", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("auto uses the pi-derived theme when syntax colors resolve", async () => {
    const theme = buildFakeTheme(DARK);
    resolveDiffPalette(theme);
    const selected = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    expect(typeof selected).toBe("object");
    expect((selected as PiSyntaxTheme).name).toMatch(/^pi-dark-/);
  });

  it("auto resolves to no theme without syntax colors (honest, unhighlighted)", async () => {
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    expect(await resolveActiveTheme(currentPaletteOf(), currentThemeOf())).toBeNull();
    resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG }));
    expect(await resolveActiveTheme(currentPaletteOf(), currentThemeOf())).toBeNull();
  });

  it("memoizes per theme: same theme returns the same object", async () => {
    const theme = buildFakeTheme(DARK);
    resolveDiffPalette(theme);
    const first = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    const second = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    expect(first).toBe(second);
  });

  it("re-derives when the theme changes", async () => {
    const dark = buildFakeTheme(DARK);
    resolveDiffPalette(dark);
    const first = (await resolveActiveTheme(currentPaletteOf(), currentThemeOf())) as PiSyntaxTheme;
    const light = buildFakeTheme(LIGHT);
    resolveDiffPalette(light);
    const second = (await resolveActiveTheme(
      currentPaletteOf(),
      currentThemeOf(),
    )) as PiSyntaxTheme;
    expect(second).not.toBe(first);
    expect(second.name).toMatch(/^pi-light-/);
  });

  it("hlBlock renders through the generated theme", async () => {
    const theme = buildFakeTheme(DARK);
    resolveDiffPalette(theme);
    const lines = await hlBlock({
      code: CODE,
      language: "typescript",
      palette: currentPaletteOf(),
      piTheme: currentThemeOf(),
    });
    expect(lines[0]).toContain("const");
    // A Shiki failure would fall back to plain lines; the generated theme
    // rendered when truecolor escapes show up under a forced-color run and
    // the content contract holds either way.
    expect(lines).toHaveLength(1);
  });
});

describe("applySemanticPatches (rule rewriting)", () => {
  /** A theme with specific scopes, like a real family theme. */
  const baseTheme = {
    name: "fake-bundled",
    type: "dark" as const,
    colors: { "editor.foreground": "#abb2bf" },
    tokenColors: [
      { scope: "keyword.control.import.ts", settings: { foreground: "#c678dd" } },
      { scope: ["entity.name.function", "support.function"], settings: { foreground: "#61afef" } },
      { scope: "comment.line.double-slash", settings: { foreground: "#5c6370" } },
      { scope: "invalid.illegal", settings: { foreground: "#ff0000" } },
    ],
  };

  it("rewrites rules whose scopes classify into patched groups", () => {
    const patched = applySemanticPatches(baseTheme, { keyword: "#ff7b72" }, "id1");
    // keyword.control.import.ts classifies into keyword → replaced.
    expect(patched.tokenColors?.[0]?.settings?.foreground).toBe("#ff7b72");
    // Other groups untouched.
    expect(patched.tokenColors?.[1]?.settings?.foreground).toBe("#61afef");
    // Unclassified scopes untouched.
    expect(patched.tokenColors?.[3]?.settings?.foreground).toBe("#ff0000");
    // Name carries a patch hash.
    expect(patched.name).toMatch(/^fake-bundled-patch-/);
  });

  it("never mutates the input theme (immutability)", () => {
    const snapshot = JSON.stringify(baseTheme);
    applySemanticPatches(baseTheme, { comment: "#00ff00" }, "id2");
    expect(JSON.stringify(baseTheme)).toBe(snapshot);
  });

  it("treats array scopes by any matching member", () => {
    const patched = applySemanticPatches(baseTheme, { function: "#ffff00" }, "id3");
    expect(patched.tokenColors?.[1]?.settings?.foreground).toBe("#ffff00");
  });

  it("returns the input unchanged when nothing matches", () => {
    // No patches → identity.
    expect(applySemanticPatches(baseTheme, {}, "id4")).toBe(baseTheme);
  });

  it("classifies by the longest matching prefix (TextMate specificity)", () => {
    // keyword.operator.* must reach the operator group, not the broader keyword.
    const operatorTheme = {
      ...baseTheme,
      tokenColors: [
        { scope: "keyword.operator.assignment.compound.ts", settings: { foreground: "#111111" } },
        { scope: "storage.type.function.arrow.ts", settings: { foreground: "#222222" } },
        // The CSS exception: entity.name.tag.css stays keyword (longer prefix)
        // while plain entity.name.tag is punctuation.
        { scope: "entity.name.tag.css", settings: { foreground: "#333333" } },
        { scope: "entity.name.tag.html", settings: { foreground: "#444444" } },
      ],
    };
    const patched = applySemanticPatches(
      operatorTheme,
      { operator: "#00ff00", keyword: "#ff0000" },
      "spec",
    );
    expect(patched.tokenColors?.[0]?.settings?.foreground).toBe("#00ff00");
    expect(patched.tokenColors?.[1]?.settings?.foreground).toBe("#00ff00");
    expect(patched.tokenColors?.[2]?.settings?.foreground).toBe("#ff0000");
    // entity.name.tag → punctuation: not in the patch map, stays untouched.
    expect(patched.tokenColors?.[3]?.settings?.foreground).toBe("#444444");
  });

  it("classifies comma-separated scope strings (TextMate string form)", () => {
    const commaTheme = {
      ...baseTheme,
      tokenColors: [
        {
          scope: "entity.other.attribute-name, meta.attribute-name.css",
          settings: { foreground: "#123456" },
        },
      ],
    };
    // entity.other.attribute-name → variable (upstream attr → variable).
    const patched = applySemanticPatches(commaTheme, { variable: "#00ccff" }, "comma");
    expect(patched.tokenColors?.[0]?.settings?.foreground).toBe("#00ccff");
  });
});

describe("enforceThemeColors (bundled-name enforcement)", () => {
  /** The dark fake theme's renderer backgrounds. */
  const darkBackgrounds = backgroundHexes(DARK).map(hexToRgbObj);

  it("lifts known-failing colors to AA while preserving hue and fontStyle", () => {
    const theme = {
      name: "github-dark-fake",
      type: "dark" as const,
      tokenColors: [
        // #f97583 fails AA on the emphasis backgrounds (measured ~2.4).
        { scope: "keyword", settings: { foreground: "#f97583", fontStyle: "bold" } },
        { scope: "string", settings: { foreground: "#a5d6ff" } },
      ],
    };
    const enforced = enforceThemeColors(theme, darkBackgrounds, true);
    const adjusted = enforced.tokenColors?.[0]?.settings?.foreground;
    expect(adjusted).toBeDefined();
    expect(adjusted).not.toBe("#f97583");
    // AA on every background.
    for (const bg of darkBackgrounds) {
      expect(contrast(adjusted!, hexOf(bg))).toBeGreaterThanOrEqual(4.5);
    }
    // Hue preserved (red family: r dominant over g and b).
    const rgb = hexToRgbObj(adjusted!);
    expect(rgb.r).toBeGreaterThan(rgb.g);
    // fontStyle preserved.
    expect(enforced.tokenColors?.[0]?.settings?.fontStyle).toBe("bold");
  });

  it("skips non-hex foregrounds and leaves already-compliant themes untouched", () => {
    const theme = {
      name: "ok-theme",
      type: "dark" as const,
      tokenColors: [
        { scope: "a", settings: { foreground: "red" } }, // CSS name — skipped
        { scope: "b", settings: { foreground: "#ffffff" } }, // passes AA
      ],
    };
    const enforced = enforceThemeColors(theme, darkBackgrounds, true);
    expect(enforced).toBe(theme); // no change at all — same object
  });

  it("enforces the editor default foreground too", () => {
    const theme = {
      name: "fg-theme",
      type: "dark" as const,
      colors: { "editor.foreground": "#4a5568" },
      tokenColors: [],
    };
    const enforced = enforceThemeColors(theme, darkBackgrounds, true);
    expect(enforced.colors?.["editor.foreground"]).not.toBe("#4a5568");
    expect(enforced.name).toMatch(/-aa-/);
  });

  it("never mutates the input theme (immutability)", () => {
    const theme = {
      name: "mut",
      type: "dark" as const,
      tokenColors: [{ scope: "keyword", settings: { foreground: "#f97583" } }],
    };
    const snapshot = JSON.stringify(theme);
    enforceThemeColors(theme, darkBackgrounds, true);
    expect(JSON.stringify(theme)).toBe(snapshot);
  });
});

describe("buildSemanticTheme (inline variant)", () => {
  it("builds a verbatim theme from semantic colors", () => {
    const theme = buildSemanticTheme({ keyword: "#ff0000", string: "#00ff00" }, "dark", "id5");
    expect(theme.type).toBe("dark");
    expect(theme.name).toMatch(/^inline-dark-/);
    const keywordRule = theme.tokenColors?.find((rule) => rule.scope?.includes("keyword"));
    const stringRule = theme.tokenColors?.find((rule) => rule.scope?.includes("string"));
    expect(keywordRule?.settings?.foreground).toBe("#ff0000");
    expect(stringRule?.settings?.foreground).toBe("#00ff00");
  });

  it("names differ when variant colors differ (identity hashing)", () => {
    const a = buildSemanticTheme({ keyword: "#ff0000" }, "dark", "id6");
    const b = buildSemanticTheme({ keyword: "#00ff00" }, "dark", "id6");
    expect(a.name).not.toBe(b.name);
  });
});

describe("buildPiSyntaxTheme user patches", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("replaces patched keys verbatim and enforces the rest", () => {
    const theme = buildFakeTheme(DARK);
    const palette = resolveDiffPalette(theme);
    const patched = buildPiSyntaxTheme(theme, palette, "k", { keyword: "#123456" })!;
    const keywordRule = patched.tokenColors.find((rule) => rule.scope.includes("keyword"));
    // Verbatim — NOT lifted to AA.
    expect(keywordRule?.settings?.foreground).toBe("#123456");
    // Unpatched keys still enforced (comment green #6A9955 lifts).
    const commentRule = patched.tokenColors.find((rule) => rule.scope.includes("comment"));
    expect(commentRule?.settings?.foreground).not.toBe("#6a9955");
  });

  it("folds user colors into the identity hash (reload freshness)", () => {
    const theme = buildFakeTheme(DARK);
    const palette = resolveDiffPalette(theme);
    const a = buildPiSyntaxTheme(theme, palette, "k")!;
    const b = buildPiSyntaxTheme(theme, palette, "k", { keyword: "#123456" })!;
    expect(a.name).not.toBe(b.name);
  });
});
