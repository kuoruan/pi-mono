import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { renderUnified } from "#src/render/unified-view.ts";
import { registeredSourceOf } from "#src/theme/theme-registry.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import { collectConvertedThemes } from "#src/theme/user-themes.ts";
import { buildFakeTheme, makeRenderSession, registerTools, viewFor } from "#test/fixtures.ts";
/**
 * The detection chain, end to end (ADR 0006): an active pi theme whose
 * name is one of OURS (the registered, converted themes) drives the
 * precise pipeline — the mapped shiki theme's full tokenColors, AA
 * enforced against the scheme's blend backgrounds, rendered bytes and
 * all. An external theme falls back to the nine-color derivation.
 */
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

describe("ours-detection (the registry)", () => {
  it("maps a registered bundled name to its shiki source", () => {
    expect(registeredSourceOf("pigment-solarized-light", [])).toEqual({
      kind: "bundled",
      themeName: "solarized-light",
    });
    expect(registeredSourceOf("pigment-vitesse-black", [])).toEqual({
      kind: "bundled",
      themeName: "vitesse-black",
    });
  });

  it("treats external and unknown names as external", () => {
    expect(registeredSourceOf("light", [])).toBeUndefined();
    expect(registeredSourceOf("dark", [])).toBeUndefined();
    expect(registeredSourceOf("my-custom-theme", [])).toBeUndefined();
    // The prefix alone is not enough — the shiki source must exist.
    expect(registeredSourceOf("pigment-not-a-bundled-theme", [])).toBeUndefined();
    expect(registeredSourceOf(undefined, [])).toBeUndefined();
  });
});

describe("the precise pipeline (ours → full tokenColors)", () => {
  it("an ours-named pi theme renders the mapped shiki theme's token colors", async () => {
    // A fake pi theme carrying an ours name — the detection input.
    const fake = buildFakeTheme({ name: "pigment-solarized-light" });
    const active = await viewFor(fake).activeTheme();
    // The active theme IS solarized-light (the bundled object, enforced).
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toContain("solarized-light");
  });

  it("an external pi theme derives from its nine colors (the follower path)", async () => {
    // A fake with the nine syntax colors: the derivation succeeds.
    const fake = buildFakeTheme({ syntaxColors: true, name: "external-theme" });
    const active = await viewFor(fake).activeTheme();
    expect(active).not.toBeNull();
    // The derived theme is the nine-color semantic form (the pi-derived
    // name prefix; the AA-enforced values replace the raw ANSI inputs).
    expect(typeof active !== "string" && active?.name).toMatch(/^pi-dark-/);
    expect(typeof active !== "string" && Array.isArray(active?.tokenColors)).toBe(true);
  });

  it("a USER ours-source renders verbatim (runtime AA is for bundled themes only)", async () => {
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
    // The output exists too: the pair is a conversion, collected by the session.
    writeFile(
      join(dir, ".pi", "extensions", "pigment", "themes", "pigment-low.json"),
      JSON.stringify({ name: "pigment-low", colors: {} }),
    );
    const env = { cwd: dir, agentDir: join(dir, "agent") };
    const fake = buildFakeTheme({ name: "pigment-low" });
    const active = await makeRenderSession({
      selection: { kind: "auto" },
      themeEnv: env,
      convertedThemes: collectConvertedThemes(env),
    })
      .forTheme(fake)
      .activeTheme();
    expect(active).not.toBeNull();
    expect(JSON.stringify(active)).toContain("#2a2a2a"); // verbatim, never nudged
  });

  it("a converted source deleted MID-SESSION degrades to the derived path (never breaks)", async () => {
    // The session collected the pair at session_start; the source vanishes
    // afterwards. The ours-lookup still maps the name, the lazy file load
    // finds nothing, and the chain falls through to the pi-derived nine
    // colors — a render must never throw on a deleted theme file.
    const dir = "/mid-session-project";
    const env = { cwd: dir, agentDir: join(dir, "agent") };
    const themesDir = join(dir, ".pi", "extensions", "pigment", "themes");
    writeFile(
      join(themesDir, "low.json"),
      JSON.stringify({
        type: "dark",
        colors: { "editor.background": "#282c34" },
        tokenColors: [{ scope: "keyword", settings: { foreground: "#c678dd" } }],
      }),
    );
    writeFile(join(themesDir, "pigment-low.json"), JSON.stringify({ name: "pigment-low" }));
    const converted = collectConvertedThemes(env);
    expect(converted).toEqual([{ name: "pigment-low", stem: "low" }]);
    // The source disappears after the collection.
    vol.unlinkSync(join(themesDir, "low.json"));

    const fake = buildFakeTheme({ name: "pigment-low", syntaxColors: true });
    const active = await makeRenderSession({
      selection: { kind: "auto" },
      themeEnv: env,
      convertedThemes: converted,
    })
      .forTheme(fake)
      .activeTheme();
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toMatch(/^pi-dark-/);
  });

  it("an output whose source is gone is not ours at all (external path)", async () => {
    // The conversion PAIR is the collection unit: an output without a live
    // source stands alone (external theme — its own nine colors derive).
    const dir = "/orphan-project";
    writeFile(
      join(dir, ".pi", "extensions", "pigment", "themes", "pigment-gone.json"),
      JSON.stringify({ name: "pigment-gone", colors: {} }),
    );
    const env = { cwd: dir, agentDir: join(dir, "agent") };
    expect(collectConvertedThemes(env)).toEqual([]);
    const fake = buildFakeTheme({ name: "pigment-gone", syntaxColors: true });
    const active = await makeRenderSession({
      selection: { kind: "auto" },
      themeEnv: env,
      convertedThemes: collectConvertedThemes(env),
    })
      .forTheme(fake)
      .activeTheme();
    expect(active).not.toBeNull();
    expect(typeof active !== "string" && active?.name).toMatch(/^pi-dark-/);
  });
});

describe("session_start assembly (the detection in place)", () => {
  it("a config-less session registers tools and follows the pi theme", async () => {
    vol.reset();
    const dir = "/assembly-project";
    mkdirSync(join(dir, ".pi", "extensions", "pigment"), { recursive: true });
    // No config file at all: zero-config — the tools register, the
    // scheme derives from the pi theme, ours-detection runs per render.
    const tools = await registerTools({ cwd: dir, agentDir: join(dir, "agent") });
    expect(tools.length).toBe(7);
    const scheme = viewFor(buildFakeTheme()).scheme;
    expect(scheme.bgBase).toBeTruthy(); // the pi theme's own canvas
  });

  it("an unresolvable override falls back to auto — tools still register, issue lands on stderr", async () => {
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
    }
  });
});

describe("rendered bytes: ours vs override (the two token sources)", () => {
  it("the override layer renders its theme's tokens over the pi canvas", async () => {
    // The override (syntaxTheme explicit) selects token colors only —
    // the canvas stays the pi theme's. Byte-level: a fake DARK pi theme
    // + a vitesse-dark override renders vitesse's colors.
    // A slash pair through the real resolver: the dark half (the fake
    // theme reads as dark) renders its tokens over the pi canvas.
    const { selection } = await resolveSyntaxThemeSelection("vitesse-light/vitesse-dark", {
      cwd: "/nonexistent-project",
      agentDir: "/nonexistent-agent",
    });
    const view = makeRenderSession({ selection }).forTheme(buildFakeTheme());
    const active = await view.activeTheme();
    expect(active).not.toBeNull();
    const diff = parseDiff("const a = 1;\n", "const a = 2;\n");
    const out = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      view,
      indicator: "bar",
    });
    expect(out).toBeTruthy();
    expect(out).toContain("▌");
  });
});
