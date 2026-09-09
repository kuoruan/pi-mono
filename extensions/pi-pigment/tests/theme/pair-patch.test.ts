import { describe, expect, it, afterEach } from "vitest";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { resolveDiffPalette, setDiffRoots } from "#src/theme/palette.ts";
import {
  hasPatches,
  resolveActiveTheme,
  setSyntaxThemeSelection,
} from "#src/theme/theme-selection.ts";
import { buildFakeTheme, resetPigmentForTest } from "#test/fixtures.ts";

/**
 * An object selection (a slash-pair base of bundled names + semantic
 * patches) must apply its patches on every resolution path. The drop
 * happened only when the base needed zero AA enforcement
 * (enforceLoadedFile returned the string id) — a combination no bundled
 * theme reaches under any tested diff roots, so this guards the
 * restructured branch and the load-and-patch fallback for future themes.
 */
// Roots set inside these tests must not leak past the file (the sibling
// suites restore theirs; this file historically didn't).
afterEach(() => {
  setDiffRoots(undefined);
});

describe("pair-base object selection applies patches", () => {
  it("applies the patch color over the enforced bundled base", async () => {
    resetPigmentForTest();
    setDiffRoots({
      topLevel: { removed: { tint: "#2b1a1a66" } },
    });
    const theme = buildFakeTheme({ syntaxColors: true });
    const palette = resolveDiffPalette(theme);
    // The dark half of the pair (the fake theme reads as dark).
    setSyntaxThemeSelection({
      kind: "object",
      base: {
        kind: "pair",
        light: {
          name: "github-light",
          theme: { name: "github-light", type: "light" } as never,
          bundled: true,
        },
        dark: {
          name: "github-dark",
          theme: { name: "github-dark", type: "dark" } as never,
          bundled: true,
        },
      },
      colors: { keyword: "#ff00ff" },
    });
    const active = await resolveActiveTheme(palette, theme);
    expect(typeof active).toBe("object");
    const tc =
      (active as { tokenColors?: { settings?: { foreground?: string } }[] }).tokenColors ?? [];
    expect(tc.some((r) => r.settings?.foreground?.toLowerCase() === "#ff00ff")).toBe(true);
  });
});

describe("variant-mode color merge (top-level colors under variants)", () => {
  it("merges the top-level colors with the variant's (variant wins per key)", async () => {
    resetPigmentForTest();
    const theme = buildFakeTheme({ syntaxColors: true });
    const palette = resolveDiffPalette(theme);
    setSyntaxThemeSelection({
      kind: "object",
      base: { kind: "auto" },
      colors: { comment: "#657b83", keyword: "#top-level-must-lose" },
      dark: { colors: { keyword: "#bb9af7" } },
    });
    const active = await resolveActiveTheme(palette, theme);
    expect(typeof active).toBe("object");
    const tc =
      (
        active as {
          tokenColors?: { scope?: string | string[]; settings?: { foreground?: string } }[];
        }
      ).tokenColors ?? [];
    const fg = (name: string): string | undefined =>
      tc.find((r) => {
        const scopes = Array.isArray(r.scope) ? r.scope : [r.scope];
        return scopes.some((s) => s?.includes(name));
      })?.settings?.foreground;
    // The variant's keyword wins over the top-level value…
    expect(fg("keyword")?.toLowerCase()).toBe("#bb9af7");
    // …and the top-level comment survives under the variant (the merge,
    // not the variant alone, feeds the built theme).
    expect(fg("comment")?.toLowerCase()).toBe("#657b83");
  });
});

describe("AA-clean path atoms", () => {
  it("hasPatches: empty patch maps carry no overlay", () => {
    expect(hasPatches({})).toBe(false);
    expect(hasPatches({ keyword: "#ff00ff" })).toBe(true);
  });

  it("loadBundledTheme: resolves known ids to objects, unknown to undefined", async () => {
    const theme = await loadBundledTheme("github-dark");
    expect(theme).toBeDefined();
    expect(typeof (theme as { name?: string }).name).toBe("string");
    expect(await loadBundledTheme("nonexistent-theme-xyz" as never)).toBeUndefined();
  });
});
