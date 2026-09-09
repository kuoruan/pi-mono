import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The detection chain, end to end (ADR 0006): an active pi theme whose
 * name is one of OURS (the registered, converted themes) drives the
 * precise pipeline — the mapped shiki theme's full tokenColors, AA
 * enforced against the palette's blend backgrounds, rendered bytes and
 * all. An external theme falls back to the nine-color derivation.
 */
import { vol } from "memfs";
import { afterAll, describe, expect, it, vi } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { renderUnified } from "#src/render/render-unified.ts";
import { resetPaletteForTest, resolveDiffPalette } from "#src/theme/palette.ts";
import {
  registeredSourceOf,
  registerUserTheme,
  resetRegistryForTest,
} from "#src/theme/theme-registry.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import {
  resetSyntaxThemeForTest,
  resolveActiveTheme,
  setSyntaxThemeSelection,
} from "#src/theme/theme-selection.ts";
import { setUserThemeEnv } from "#src/theme/user-themes.ts";
import { buildFakeTheme, registerTools } from "#test/fixtures.ts";
import { writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

describe("ours-detection (the registry)", () => {
  it("maps a registered bundled name to its shiki source", () => {
    expect(registeredSourceOf("pigment-solarized-light")).toEqual({
      kind: "bundled",
      themeName: "solarized-light",
    });
    expect(registeredSourceOf("pigment-vitesse-black")).toEqual({
      kind: "bundled",
      themeName: "vitesse-black",
    });
  });

  it("treats external and unknown names as external", () => {
    expect(registeredSourceOf("light")).toBeUndefined();
    expect(registeredSourceOf("dark")).toBeUndefined();
    expect(registeredSourceOf("my-custom-theme")).toBeUndefined();
    // The prefix alone is not enough — the shiki source must exist.
    expect(registeredSourceOf("pigment-not-a-bundled-theme")).toBeUndefined();
    expect(registeredSourceOf(undefined)).toBeUndefined();
  });
});

describe("the precise pipeline (ours → full tokenColors)", () => {
  it("an ours-named pi theme renders the mapped shiki theme's token colors", async () => {
    resetSyntaxThemeForTest();
    resetPaletteForTest();
    setSyntaxThemeSelection({ kind: "auto" });
    // A fake pi theme carrying an ours name — the detection input.
    const fake = buildFakeTheme({ name: "pigment-solarized-light" });
    const palette = resolveDiffPalette(fake);
    const active = await resolveActiveTheme(palette, fake);
    // The active theme IS solarized-light (the bundled object, enforced).
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toContain("solarized-light");
  });

  it("an external pi theme derives from its nine colors (the follower path)", async () => {
    resetSyntaxThemeForTest();
    resetPaletteForTest();
    setSyntaxThemeSelection({ kind: "auto" });
    // A fake with the nine syntax colors: the derivation succeeds.
    const fake = buildFakeTheme({ syntaxColors: true, name: "external-theme" });
    const palette = resolveDiffPalette(fake);
    const active = await resolveActiveTheme(palette, fake);
    expect(active).not.toBeNull();
    // The derived theme is the nine-color semantic form (the pi-derived
    // name prefix; the AA-enforced values replace the raw ANSI inputs).
    expect(typeof active !== "string" && active?.name).toMatch(/^pi-dark-/);
    expect(typeof active !== "string" && Array.isArray(active?.tokenColors)).toBe(true);
  });

  it("a USER ours-source renders verbatim (runtime AA is for bundled themes only)", async () => {
    resetRegistryForTest();
    resetSyntaxThemeForTest();
    resetPaletteForTest();
    setSyntaxThemeSelection({ kind: "auto" });
    const dir = "/verbatim-project";
    // A source whose keyword color is nearly invisible on its own
    // canvas — exactly the color the runtime sweep would nudge. The user
    // channel keeps it byte-for-byte (the enforcement boundary).
    writeFile(
      join(dir, ".pi", "extensions", "pigment", "themes", "low.json"),
      JSON.stringify({
        type: "dark",
        colors: { "editor.background": "#282c34" },
        tokenColors: [{ scope: "keyword", settings: { foreground: "#2a2a2a" } }],
      }),
    );
    setUserThemeEnv({ cwd: dir, agentDir: join(dir, "agent") });
    registerUserTheme("low", "pigment-low");
    const fake = buildFakeTheme({ name: "pigment-low" });
    const active = await resolveActiveTheme(resolveDiffPalette(fake), fake);
    expect(active).not.toBeNull();
    expect(JSON.stringify(active)).toContain("#2a2a2a"); // verbatim, never nudged
  });

  it("a registered user theme whose source is gone falls to the derived path (degraded, never broken)", async () => {
    resetRegistryForTest();
    resetSyntaxThemeForTest();
    resetPaletteForTest();
    setSyntaxThemeSelection({ kind: "auto" });
    // Registered at resources_discover, the source deleted afterwards:
    // the ours-lookup still hits the registry, the file load fails, and
    // the chain falls through to the pi-derived nine colors.
    registerUserTheme("gone", "pigment-gone");
    const fake = buildFakeTheme({ name: "pigment-gone", syntaxColors: true });
    const active = await resolveActiveTheme(resolveDiffPalette(fake), fake);
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toMatch(/^pi-dark-/);
  });
});

describe("session_start assembly (the detection in place)", () => {
  it("a config-less session registers tools and follows the pi theme", async () => {
    resetPaletteForTest();
    vol.reset();
    const dir = "/assembly-project";
    mkdirSync(join(dir, ".pi", "extensions", "pigment"), { recursive: true });
    // No config file at all: zero-config — the tools register, the
    // palette derives from the pi theme, ours-detection runs per render.
    const tools = await registerTools({ cwd: dir, agentDir: join(dir, "agent") });
    expect(tools.length).toBe(7);
    const palette = resolveDiffPalette(buildFakeTheme());
    expect(palette.bgBase).toBeTruthy(); // the pi theme's own canvas
    resetSyntaxThemeForTest();
  });

  it("an unresolvable override falls back to auto — tools still register, issue lands on stderr", async () => {
    resetPaletteForTest();
    vol.reset();
    const dir = "/assembly-project";
    mkdirSync(join(dir, ".pi", "extensions", "pigment"), { recursive: true });
    writeFile(join(dir, ".pi", "extensions", "pigment", "config.jsonc"), {
      syntaxTheme: "no-such-theme",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tools = await registerTools({ cwd: dir, agentDir: join(dir, "agent") });
      expect(tools.length).toBe(7); // a config error never disables the renderer
      expect(stderr.mock.calls.flat().join("\n")).toMatch(/no-such-theme/);
    } finally {
      stderr.mockRestore();
      resetSyntaxThemeForTest();
    }
  });
});

describe("rendered bytes: ours vs override (the two token sources)", () => {
  it("the override layer renders its theme's tokens over the pi canvas", async () => {
    // The override (syntaxTheme explicit) selects token colors only —
    // the canvas stays the pi theme's. Byte-level: a fake DARK pi theme
    // + a vitesse-dark override renders vitesse's colors.
    resetSyntaxThemeForTest();
    resetPaletteForTest();
    // A slash pair through the real resolver: the dark half (the fake
    // theme reads as dark) renders its tokens over the pi canvas.
    const { selection } = await resolveSyntaxThemeSelection("vitesse-light/vitesse-dark", {
      cwd: "/nonexistent-project",
      agentDir: "/nonexistent-agent",
    });
    setSyntaxThemeSelection(selection);
    const palette = resolveDiffPalette(buildFakeTheme());
    const active = await resolveActiveTheme(palette, buildFakeTheme());
    expect(active).not.toBeNull();
    const diff = parseDiff("const a = 1;\n", "const a = 2;\n");
    const out = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      palette,
      indicator: "bar",
    });
    expect(out).toBeTruthy();
    expect(out).toContain("▌");
    resetSyntaxThemeForTest();
  });
});

// Keep the registry clean for other suites (the bundled derivations are
// pure, but user registrations from other tests would leak).
afterAll(() => {
  resetRegistryForTest();
});
