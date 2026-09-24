/**
 * The session render seam's tests: the seam's own contracts — the scheme
 * equals the pure derivation, the active-theme observation point sees the
 * detection chain's product, and two sessions in one process never
 * pollute each other.
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRenderSession, type RenderSessionInputs } from "#src/render/session.ts";
import { deriveResolvedTheme, type PaletteTheme } from "#src/theme/scheme.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import { collectConvertedThemes } from "#src/theme/user-themes.ts";
import { buildFakeTheme, makeRenderSession, viewFor } from "#test/fixtures.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

const CODE = "const answer = 42;\n// groovy\n";
const LANGUAGE = "typescript" as const;
const ENV = { cwd: "/identity-project", agentDir: "/identity-project/agent" };

/**
 * The dark fake theme with the nine syntax colors (the derivable path).
 *
 * @param name - Optional theme name (the ours-detection input).
 * @returns The fake theme.
 */
function darkTheme(name?: string): PaletteTheme {
  return buildFakeTheme({ syntaxColors: true, name });
}

describe("the scheme seam", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("forTheme returns exactly the pure derivation (no hidden singleton state)", () => {
    const theme = darkTheme("external-theme");
    const roots = { topLevel: { added: { text: "#7ee787" } } };
    const view = createRenderSession({
      diffRoots: roots,
      selection: { kind: "auto" },
      themeEnv: ENV,
      convertedThemes: [],
    }).forTheme(theme);
    expect(view.scheme).toEqual(deriveResolvedTheme(theme, roots).scheme);
    expect(view.theme).toBe(theme);
  });

  it("an unreadable theme lands on the fallback scheme", () => {
    expect(viewFor({} as PaletteTheme).scheme).toEqual(
      deriveResolvedTheme(undefined, undefined).scheme,
    );
  });

  it("reports a polarity contradiction once per session", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const inputs: RenderSessionInputs = {
      // A light tint over the dark fake's canvas: the composited color
      // contradicts the pi theme's polarity.
      diffRoots: { topLevel: { added: { tint: "#ffffffcc" } } },
      selection: { kind: "auto" },
      themeEnv: ENV,
      convertedThemes: [],
    };
    const session = createRenderSession(inputs);
    session.forTheme(darkTheme());
    session.forTheme(darkTheme());
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe(
      "[pi-pigment] diff root override(s) added.tint contradict the pi theme's polarity — " +
        "WCAG enforcement assumes a consistent palette.",
    );
    // A second session reports its own (the flag is per session, not module).
    createRenderSession(inputs).forTheme(darkTheme());
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("the active-theme observation point", () => {
  it("sees the detection chain's product: the derived follower theme", async () => {
    const view = viewFor(darkTheme("external-theme"));
    const active = await view.activeTheme();
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toMatch(/^pi-dark-/);
    expect(typeof active !== "string" && Array.isArray(active?.tokenColors)).toBe(true);
  });

  it("sees the precise pipeline: an ours-named pi theme maps to its shiki source", async () => {
    const view = viewFor(darkTheme("pigment-solarized-light"));
    const active = await view.activeTheme();
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toContain("solarized-light");
  });

  it("an explicit bundled selection resolves to that theme (golden-name home)", async () => {
    const { selection } = await resolveSyntaxThemeSelection("vitesse-dark", ENV);
    const view = createRenderSession({
      diffRoots: undefined,
      selection,
      themeEnv: ENV,
      convertedThemes: [],
    }).forTheme(darkTheme("external-theme"));
    const active = await view.activeTheme();
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toContain("vitesse-dark");
  });

  it("highlight renders through the session's resolution", async () => {
    const view = viewFor(darkTheme("external-theme"));
    const lines = await view.highlight({ code: CODE, language: LANGUAGE });
    expect(lines).toHaveLength(2);
    // Syntax-colored: the derived theme's token colors reach the bytes.
    // eslint-disable-next-line no-control-regex -- matches the SGR escape
    expect(lines.join("\n")).toMatch(/\x1b\[38;2;/);
  });
});

/**
 * Write a converted source+output pair into a project themes dir.
 *
 * @param dir - The project root.
 * @param keyword - The keyword color (the identity discriminator).
 */
function writeConvertedTheme(dir: string, keyword: string): void {
  const themesDir = join(dir, ".pi", "extensions", "pigment", "themes");
  // The SOURCE (ours-detection loads it for full tokenColors precision).
  writeFile(
    join(themesDir, "low.json"),
    JSON.stringify({
      type: "dark",
      colors: { "editor.background": "#282c34" },
      tokenColors: [{ scope: "keyword", settings: { foreground: keyword } }],
    }),
  );
  // The OUTPUT (its existence is what makes the pair a conversion).
  writeFile(join(themesDir, "pigment-low.json"), JSON.stringify({ name: "pigment-low" }));
}

describe("identity completeness (two sessions, one process)", () => {
  beforeEach(() => {
    vol.reset();
  });
  afterEach(() => {
    vol.reset();
  });

  it("same theme name, different env contents: resolutions and highlights do not cross", async () => {
    const dirA = "/session-a";
    const dirB = "/session-b";
    writeConvertedTheme(dirA, "#c678dd");
    writeConvertedTheme(dirB, "#61afef");

    const envA = { cwd: dirA, agentDir: join(dirA, "agent") };
    const envB = { cwd: dirB, agentDir: join(dirB, "agent") };
    // Two sessions, SAME pi theme name, built back to back in one process.
    const sessionA = createRenderSession({
      diffRoots: undefined,
      selection: { kind: "auto" },
      themeEnv: envA,
      convertedThemes: collectConvertedThemes(envA),
    });
    const sessionB = createRenderSession({
      diffRoots: undefined,
      selection: { kind: "auto" },
      themeEnv: envB,
      convertedThemes: collectConvertedThemes(envB),
    });
    const theme = darkTheme("pigment-low");
    const viewA = sessionA.forTheme(theme);
    const viewB = sessionB.forTheme(theme);

    // Each session resolved its OWN file's keyword color — the discriminator
    // the old module-level memo (selection + theme name only) could confuse.
    expect(JSON.stringify(await viewA.activeTheme())).toContain("#c678dd");
    expect(JSON.stringify(await viewB.activeTheme())).toContain("#61afef");
    const linesA = await viewA.highlight({ code: CODE, language: LANGUAGE });
    const linesB = await viewB.highlight({ code: CODE, language: LANGUAGE });
    expect(linesA).not.toEqual(linesB);
    // Re-resolving A after B is stable (the memo did not get clobbered).
    expect(JSON.stringify(await viewA.activeTheme())).toContain("#c678dd");
  });

  it("sessions with different selections stay independent", async () => {
    const theme = darkTheme("external-theme");
    const env = { cwd: "/selection-project", agentDir: "/selection-project/agent" };
    const derived = createRenderSession({
      diffRoots: undefined,
      selection: { kind: "auto" },
      themeEnv: env,
      convertedThemes: [],
    }).forTheme(theme);
    const patched = createRenderSession({
      diffRoots: undefined,
      selection: {
        kind: "object",
        base: { kind: "auto" },
        colors: { keyword: "#c678dd" },
      },
      themeEnv: env,
      convertedThemes: [],
    }).forTheme(theme);

    const derivedTheme = JSON.stringify(await derived.activeTheme());
    const patchedTheme = JSON.stringify(await patched.activeTheme());
    expect(patchedTheme).not.toBe(derivedTheme);
    // Interleaving does not swap the resolutions.
    expect(JSON.stringify(await derived.activeTheme())).toBe(derivedTheme);
  });

  it("a session built with no roots differs from one with roots (input-driven, no ambient)", () => {
    const theme = darkTheme();
    expect(makeRenderSession().forTheme(theme).scheme).toEqual(
      deriveResolvedTheme(theme, undefined).scheme,
    );
    const rooted = makeRenderSession({
      diffRoots: { topLevel: { removed: { text: "#ff0000" } } },
    }).forTheme(theme);
    expect(rooted.scheme).not.toEqual(deriveResolvedTheme(theme, undefined).scheme);
  });
});
