import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import {
  detectLanguage,
  hlBlock,
  MAX_HL_CHARS,
  MAX_SEED_CHARS,
  needsSeed,
} from "#src/theme/highlight.ts";
import {
  currentPalette as currentPaletteOf,
  currentTheme as currentThemeOf,
  resolveDiffPalette,
  setDiffRoots,
} from "#src/theme/palette.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import {
  resetSyntaxThemeForTest,
  resolveActiveTheme,
  setSyntaxThemeSelection,
} from "#src/theme/theme-selection.ts";
import { buildFakeTheme, resetPigmentForTest } from "#test/fixtures.ts";

const DARK_BG = "\x1b[48;2;20;20;30m";
const LIGHT_BG = "\x1b[48;2;250;250;250m";

const CODE = "const answer = 42;\n";

/**
 * The loose theme-object view tests read from resolveActiveTheme: a name
 * plus optional token rules (scope may be string or array).
 */
interface LooseTheme {
  name: string;
  tokenColors?: { scope?: string | string[]; settings: { foreground?: string } }[];
}

describe("detectLanguage", () => {
  it("maps extensions through the SDK's map, Shiki's keys, and the header extras", () => {
    // The SDK's own extension map is the first authority.
    expect(detectLanguage("src/app.ts")).toBe("typescript");
    expect(detectLanguage("script.mjs")).toBe("javascript");
    expect(detectLanguage("header.h")).toBe("c");
    expect(detectLanguage("header.hpp")).toBe("cpp");
    expect(detectLanguage("impl.cc")).toBe("cpp");
    expect(detectLanguage("run.zsh")).toBe("bash");
    // Extensionless convention files match their whole (lowercased) name.
    expect(detectLanguage("Makefile")).toBe("makefile");
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    // Shiki's key set covers the newer extensions the SDK map lacks.
    expect(detectLanguage("main.zig")).toBe("zig");
    expect(detectLanguage("cli.nu")).toBe("nu");
    expect(detectLanguage("style.scss")).toBe("scss");
    // The two header spellings neither carries.
    expect(detectLanguage("impl.hxx")).toBe("cpp");
    expect(detectLanguage("impl.hh")).toBe("cpp");
    // Non-language words stay undefined.
    expect(detectLanguage("noext")).toBeUndefined();
    expect(detectLanguage("README")).toBeUndefined();
    expect(detectLanguage("app")).toBeUndefined();
  });
});

describe("needsSeed (the grammar-seed gate)", () => {
  it("admits the grammars that embed another syntax", () => {
    for (const path of [
      "app.vue",
      "App.svelte",
      "page.astro",
      "index.html",
      "notes.md",
      "doc.mdx",
      "index.php",
      "view.erb",
      "template.hbs",
      "page.liquid",
    ]) {
      expect(needsSeed(detectLanguage(path))).toBe(true);
    }
  });

  it("turns away languages whose tokenize a seed cannot change", () => {
    // tsx/jsx carry JSX inside the TS/JS grammar itself — the tag-looking
    // syntax is not an embedded grammar, so no seed is warranted.
    for (const path of [
      "app.ts",
      "main.tsx",
      "view.jsx",
      "script.py",
      "main.go",
      "lib.rs",
      "data.json",
      "conf.yaml",
      "style.css",
      "noext",
    ]) {
      expect(needsSeed(detectLanguage(path))).toBe(false);
    }
    expect(needsSeed(undefined)).toBe(false);
  });
});

/**
 * A fresh syntax-colored palette per call (content-identical across calls).
 *
 * @returns The resolved palette.
 */
function paletteOf(): ReturnType<typeof resolveDiffPalette> {
  return resolveDiffPalette(buildFakeTheme({ syntaxColors: true }));
}

describe("hlBlock", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("caches every render (the transient cache:false API is gone — callers skip hlBlock while streaming)", async () => {
    const themed = buildFakeTheme({ syntaxColors: true });
    const call = () =>
      hlBlock({
        code: CODE,
        language: "typescript",
        palette: paletteOf(),
        piTheme: themed,
      });
    // A repeated render is a reference hit (the LRU holds it).
    const cached1 = await call();
    const cached2 = await call();
    expect(cached2).toBe(cached1);
  });

  it("drops an oversized seed before it reaches the tokenizer", async () => {
    const themed = buildFakeTheme({ syntaxColors: true });
    const unseeded = await hlBlock({
      code: CODE,
      language: "typescript",
      palette: paletteOf(),
      piTheme: themed,
    });
    const dropped = await hlBlock({
      code: CODE,
      language: "typescript",
      palette: paletteOf(),
      piTheme: themed,
      seed: "x".repeat(MAX_SEED_CHARS + 1),
    });
    // The oversized seed is dropped: identical output, and (the same
    // cache key) the very same reference as the unseeded render.
    expect(dropped).toEqual(unseeded);
    expect(dropped).toBe(unseeded);
  });

  it("returns unhighlighted lines for unknown languages and oversized input", async () => {
    expect(
      await hlBlock({
        code: "",
        language: "typescript",
        palette: currentPaletteOf(),
        piTheme: currentThemeOf(),
      }),
    ).toEqual([""]);
    expect(
      await hlBlock({
        code: "plain",
        language: undefined,
        palette: currentPaletteOf(),
        piTheme: currentThemeOf(),
      }),
    ).toEqual(["plain"]);
    const big = "x".repeat(MAX_HL_CHARS + 1);
    expect(
      await hlBlock({
        code: big,
        language: "typescript",
        palette: currentPaletteOf(),
        piTheme: currentThemeOf(),
      }),
    ).toEqual([big]);
  });

  it("highlights code and strips the trailing newline", async () => {
    // A REAL highlighted pass: a syntax-colored fake theme resolves the
    // auto theme, the trailing newline's empty line is cut, and the
    // tokens carry truecolor escapes (the plain fallback would keep a
    // trailing empty line AND carry no escapes).
    const lines = await hlBlock({
      code: CODE,
      language: "typescript",
      palette: resolveDiffPalette(buildFakeTheme({ syntaxColors: true })),
      piTheme: buildFakeTheme({ syntaxColors: true }),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("const");
    // eslint-disable-next-line no-control-regex -- matches the SGR escape
    expect(lines[0]).toMatch(/\x1b\[38;2;/);
  });

  it("follows the palette's light/dark bit for the syntax theme", async () => {
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG, syntaxColors: true }));
    expect(await resolvedThemeName()).toMatch(/^pi-dark-/);

    resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }));
    expect(await resolvedThemeName()).toMatch(/^pi-light-/);

    // The theme participates in the cache key: prime both variants, then
    // confirm the dark entry is returned unchanged on the way back.
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const dark = await hlBlock({
      code: CODE,
      language: "typescript",
      palette: currentPaletteOf(),
      piTheme: currentThemeOf(),
    });
    resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG }));
    await hlBlock({
      code: CODE,
      language: "typescript",
      palette: currentPaletteOf(),
      piTheme: currentThemeOf(),
    });
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const again = await hlBlock({
      code: CODE,
      language: "typescript",
      palette: currentPaletteOf(),
      piTheme: currentThemeOf(),
    });
    expect(again).toEqual(dark);
  });
});

/**
 * The curated pairs (the former built-in families, now ordinary explicit
 * selections — CONFIG.md's recommended-pairs table).
 */
const RECOMMENDED_PAIRS: Record<string, { light?: string; dark?: string }> = {
  github: { light: "github-light", dark: "github-dark" },
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  one: { light: "one-light", dark: "one-dark-pro" },
  gruvbox: { light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  solarized: { light: "solarized-light", dark: "solarized-dark" },
  "rose-pine": { light: "rose-pine-dawn", dark: "rose-pine" },
  everforest: { light: "everforest-light", dark: "everforest-dark" },
  kanagawa: { light: "kanagawa-lotus", dark: "kanagawa-wave" },
  ayu: { light: "ayu-light", dark: "ayu-dark" },
  vitesse: { light: "vitesse-light", dark: "vitesse-dark" },
  min: { light: "min-light", dark: "min-dark" },
  "night-owl": { light: "night-owl-light", dark: "night-owl" },
};

/**
 * Select a config string through the real resolver (direct bundled names
 * resolve to the virtual-file selection — the direct channel).
 *
 * @param value - The syntaxTheme string value.
 */
async function selectString(value: string): Promise<void> {
  const { selection } = await resolveSyntaxThemeSelection(value, {
    cwd: "/nonexistent-project",
    agentDir: "/nonexistent-agent",
  });
  setSyntaxThemeSelection(selection);
}

/**
 * The resolved theme's identity: the bundled id, the theme object's name,
 * or "<none>" when the selection resolves to no theme.
 *
 * @returns The theme name string.
 */
async function resolvedThemeName(): Promise<string> {
  const theme = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
  if (!theme) return "<none>";
  // The active theme is either the raw id (a bundled name, AA-clean) or
  // the enforced object (whose name the materialization always sets).
  return typeof theme === "string" ? theme : theme.name;
}

describe("syntax theme selections (the pair grammar)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("auto renders unhighlighted when the pi theme lacks syntax colors", async () => {
    // No substitute fallback: honest degradation, like the large-diff path.
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    expect(await resolveActiveTheme(currentPaletteOf(), currentThemeOf())).toBeNull();
    expect(
      await hlBlock({
        code: CODE,
        language: "typescript",
        palette: currentPaletteOf(),
        piTheme: currentThemeOf(),
      }),
    ).toEqual(CODE.split("\n"));
  });

  it("every recommended pair resolves through the slash grammar and follows the palette's light/dark bit", async () => {
    for (const pair of Object.values(RECOMMENDED_PAIRS)) {
      const value = `${pair.light}/${pair.dark}`;
      await selectString(value);
      resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG, syntaxColors: true }));
      expect(await resolvedThemeName()).toMatch(
        pair.dark ? new RegExp(`^${pair.dark}-aa-`) : /^pi-dark-/,
      );
      resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }));
      expect(await resolvedThemeName()).toMatch(
        pair.light ? new RegExp(`^${pair.light}-aa-`) : /^pi-light-/,
      );
    }
  });

  it("single-polarity bundled names render on match (AA boundary), auto on the other polarity", async () => {
    // nord/dracula/monokai/tokyo-night are bundled names — B boundary:
    // enforced against the canvas (the clean id or an -aa- object), never
    // verbatim; polarity-gated to auto when the pi theme is light.
    for (const name of ["nord", "dracula", "monokai", "tokyo-night"] as const) {
      await selectString(name);
      resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG, syntaxColors: true }));
      const dark = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
      // B boundary, strictly: the clean id OR an -aa- object — but a
      // verbatim object (bare name, no suffix) must never appear.
      expect(typeof dark === "string" ? dark : (dark as LooseTheme).name).toMatch(
        new RegExp(`^${name}(-aa-.+|$)`),
      );
      expect(typeof dark === "string" ? dark : (dark as LooseTheme).name).not.toBe(name);

      resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }));
      const light = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
      expect(typeof light).toBe("object");
      expect((light as LooseTheme).name).toMatch(/^pi-light-/); // gated → auto
    }
  });

  it("every recommended-pair half is a real Shiki bundled theme", async () => {
    // The bundled-theme registry lookup is the oracle: a typo'd entry in
    // the table fails here instead of degrading to plain text at render
    // time (the intake's per-name import resolves to the theme object).
    for (const pair of Object.values(RECOMMENDED_PAIRS)) {
      for (const variant of [pair.dark, pair.light]) {
        if (!variant) continue;
        await expect(loadBundledTheme(variant as "github-dark")).resolves.toMatchObject({
          name: expect.any(String),
        });
      }
    }
  });

  it("resetSyntaxThemeForTest restores auto", async () => {
    await selectString("catppuccin-latte/catppuccin-mocha");
    resetSyntaxThemeForTest();
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG, syntaxColors: true }));
    expect(await resolvedThemeName()).toMatch(/^pi-dark-/);
  });
});

describe("theme selections (ADR 0002)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("bundled-name enforcement produces an -aa- object keyed per background set", async () => {
    await selectString("github-dark");
    // A theme WITHOUT syntax colors, so the bundled-name path (not auto) triggers.
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const theme = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    // Either the raw id (nothing to enforce) or the enforced object.
    expect(theme === null || typeof theme === "string" || theme.name.includes("-aa-")).toBe(true);
  });

  it("diff roots change enforcement backgrounds → fresh theme identity (dynamic AA)", async () => {
    await selectString("github-dark");
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const before = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());

    // Anchor the add-side word slot to a very different tint (the
    // enforcement backgrounds change with the roots).
    setDiffRoots({ topLevel: { added: { tint: "#1a2b3cdd" } } });
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const after = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());

    // New background set → the enforced identity (name suffix) changes;
    // when nothing needed enforcement both sides stay raw ids.
    const beforeName = before ? (typeof before === "string" ? before : before.name) : null;
    const afterName = after ? (typeof after === "string" ? after : after.name) : null;
    // Both sides needed enforcement (the probe shows every bundled name
    // variant forces at least one color) → the enforced identity differs.
    expect(beforeName).toMatch(/-aa-/);
    expect(afterName).toMatch(/-aa-/);
    expect(afterName).not.toBe(beforeName);
  });

  it("inline variant colors render verbatim (no -aa- enforcement)", async () => {
    setSyntaxThemeSelection({
      kind: "object",
      base: { kind: "auto" },
      colors: {},
      dark: { colors: { keyword: "#123456" } },
    });
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const theme = (await resolveActiveTheme(currentPaletteOf(), currentThemeOf())) as LooseTheme;
    expect(theme.name).toMatch(/^inline-dark-/);
    expect(theme.name).not.toMatch(/-aa-/);
    const keywordRule = theme.tokenColors?.find((rule) =>
      typeof rule.scope === "string" ? rule.scope === "keyword" : rule.scope?.includes("keyword"),
    );
    // Verbatim user color, however low the contrast.
    expect(keywordRule?.settings.foreground).toBe("#123456");
  });

  it("inline variant-mode without the current polarity's variant falls back to auto", async () => {
    setSyntaxThemeSelection({
      kind: "object",
      base: { kind: "auto" },
      colors: {},
      dark: { colors: { keyword: "#123456" } },
    });
    resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }));
    const theme = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    expect(typeof theme).toBe("object");
    expect((theme as LooseTheme).name).toMatch(/^pi-light-/);
  });

  it("patch mode on a pair base rewrites rules with the user's colors verbatim", async () => {
    const { selection } = await resolveSyntaxThemeSelection("github-light/github-dark", {
      cwd: "/nonexistent-project",
      agentDir: "/nonexistent-agent",
    });
    setSyntaxThemeSelection({
      kind: "object",
      base: selection,
      colors: { keyword: "#00ff00" },
    });
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    const theme = (await resolveActiveTheme(currentPaletteOf(), currentThemeOf())) as LooseTheme;
    expect(theme.name).toMatch(/github/);
    const keywordRules = (theme.tokenColors ?? []).filter((rule) => {
      const scopes = typeof rule.scope === "string" ? [rule.scope] : (rule.scope ?? []);
      return scopes.some((s) => s.startsWith("keyword"));
    });
    expect(keywordRules.length).toBeGreaterThan(0);
    for (const rule of keywordRules) {
      expect(rule.settings.foreground).toBe("#00ff00"); // verbatim, un-enforced
    }
  });

  it("file selections render verbatim and are polarity-gated", async () => {
    const fileTheme = {
      name: "user-dark",
      type: "dark" as const,
      tokenColors: [{ scope: "keyword", settings: { foreground: "#050505" } }],
    };
    // Dark pi theme: the file theme is used verbatim (never enforced).
    setSyntaxThemeSelection({ kind: "file", file: { name: "user-dark", theme: fileTheme } });
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG }));
    expect(await resolveActiveTheme(currentPaletteOf(), currentThemeOf())).toBe(fileTheme);

    // Light pi theme: gated → auto fallback.
    resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }));
    const gated = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    expect(typeof gated).toBe("object");
    expect((gated as LooseTheme).name).toMatch(/^pi-light-/);
  });

  it("patch mode on a polarity-gated file base continues on auto", async () => {
    const fileTheme = {
      name: "user-dark",
      type: "dark" as const,
      tokenColors: [{ scope: "keyword", settings: { foreground: "#050505" } }],
    };
    setSyntaxThemeSelection({
      kind: "object",
      base: { kind: "file", file: { name: "user-dark", theme: fileTheme } },
      colors: { keyword: "#00ff00" },
    });
    // Light pi theme: the file is gated, patches continue on the auto theme.
    resolveDiffPalette(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }));
    const theme = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    expect(typeof theme).toBe("object");
    expect((theme as LooseTheme).name).toMatch(/^pi-light-/);
    const keywordRule = (
      theme as { tokenColors?: { scope?: string | string[]; settings: { foreground?: string } }[] }
    ).tokenColors?.find((rule) =>
      typeof rule.scope === "string" ? rule.scope === "keyword" : rule.scope?.includes("keyword"),
    );
    expect(keywordRule?.settings.foreground).toBe("#00ff00");
  });

  it("memoizes the active theme: same inputs return the same object", async () => {
    resolveDiffPalette(buildFakeTheme({ successBg: DARK_BG, syntaxColors: true }));
    const first = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    const second = await resolveActiveTheme(currentPaletteOf(), currentThemeOf());
    expect(first).toBe(second);
  });
});
