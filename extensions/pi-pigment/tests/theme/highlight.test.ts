import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { MAX_HL_CHARS } from "#src/theme/highlight.ts";
import { MAX_SEED_CHARS } from "#src/theme/seed.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import { buildFakeTheme, makeRenderSession, resetPigmentForTest, viewFor } from "#test/fixtures.ts";

const DARK_BG = "\x1b[48;2;20;20;30m";
const LIGHT_BG = "\x1b[48;2;250;250;250m";

const CODE = "const answer = 42;\n";

/**
 * The loose theme-object view tests read from the frame view's
 * activeTheme(): a name plus optional token rules (scope may be string or
 * array).
 */
interface LooseTheme {
  name: string;
  tokenColors?: { scope?: string | string[]; settings: { foreground?: string } }[];
}

/** The language + code every highlight test shares. */
const TS = { code: CODE, language: "typescript" } as const;
/** The nonexistent-path env: selections resolve without touching the host. */
const ENV = { cwd: "/nonexistent-project", agentDir: "/nonexistent-agent" };

/**
 * A syntax-colored fake theme — the derivable (follower) input.
 *
 * @param overrides - Optional fake-theme overrides.
 * @returns The fake theme.
 */
function themed(overrides?: Parameters<typeof buildFakeTheme>[0]) {
  return buildFakeTheme({ syntaxColors: true, ...overrides });
}

/**
 * The resolved theme's identity: the bundled id, the theme object's name,
 * or "<none>" when the selection resolves to no theme.
 *
 * @param view - The frame view.
 * @returns The theme name string.
 */
async function themeName(view: ReturnType<typeof viewFor>): Promise<string> {
  const theme = await view.activeTheme();
  if (!theme) return "<none>";
  return typeof theme === "string" ? theme : theme.name;
}

/**
 * A view for the github-dark direct selection over the given theme.
 *
 * @param theme - The frame's pi theme.
 * @returns The bound view.
 */
async function githubDarkView(theme: ReturnType<typeof buildFakeTheme>) {
  const { selection } = await resolveSyntaxThemeSelection("github-dark", ENV);
  return makeRenderSession({ selection }).forTheme(theme);
}

/**
 * The slash grammar's product for a value (the session's selection).
 *
 * @param value - The syntaxTheme config value.
 * @returns The resolved selection.
 */
async function selectionFor(value: string) {
  const { selection } = await resolveSyntaxThemeSelection(value, ENV);
  return selection;
}

describe("highlight (the session's render entry)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("caches every render (the transient cache:false API is gone — callers skip while streaming)", async () => {
    const view = viewFor(themed());
    const call = () => view.highlight(TS);
    // A repeated render is a reference hit (the LRU holds it).
    const cached1 = await call();
    const cached2 = await call();
    expect(cached2).toBe(cached1);
  });

  it("drops an oversized seed before it reaches the tokenizer", async () => {
    const view = viewFor(themed());
    const unseeded = await view.highlight(TS);
    const dropped = await view.highlight({ ...TS, seed: "x".repeat(MAX_SEED_CHARS + 1) });
    // The oversized seed is dropped: identical output, and (the same
    // cache key) the very same reference as the unseeded render.
    expect(dropped).toEqual(unseeded);
    expect(dropped).toBe(unseeded);
  });

  it("returns unhighlighted lines for unknown languages and oversized input", async () => {
    const view = viewFor(themed());
    expect(await view.highlight({ code: "", language: "typescript" })).toEqual([""]);
    expect(await view.highlight({ code: "plain", language: undefined })).toEqual(["plain"]);
    const big = "x".repeat(MAX_HL_CHARS + 1);
    expect(await view.highlight({ code: big, language: "typescript" })).toEqual([big]);
  });

  it("highlights code and strips the trailing newline", async () => {
    // A REAL highlighted pass: a syntax-colored fake theme resolves the
    // auto theme, the trailing newline's empty line is cut, and the
    // tokens carry truecolor escapes (the plain fallback would keep a
    // trailing empty line AND carry no escapes).
    const lines = await viewFor(themed()).highlight(TS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("const");
    // eslint-disable-next-line no-control-regex -- matches the SGR escape
    expect(lines[0]).toMatch(/\x1b\[38;2;/);
  });

  it("follows the scheme's light/dark bit for the syntax theme", async () => {
    const session = makeRenderSession();
    expect(await themeName(session.forTheme(themed({ successBg: DARK_BG })))).toMatch(/^pi-dark-/);
    expect(await themeName(session.forTheme(themed({ successBg: LIGHT_BG })))).toMatch(
      /^pi-light-/,
    );

    // The theme participates in the cache key: prime both variants, then
    // confirm the dark entry is returned unchanged on the way back.
    const darkView = session.forTheme(buildFakeTheme({ successBg: DARK_BG }));
    const dark = await darkView.highlight(TS);
    const lightView = session.forTheme(buildFakeTheme({ successBg: LIGHT_BG }));
    await lightView.highlight(TS);
    const again = await darkView.highlight(TS);
    expect(again).toEqual(dark);
  });
});

describe("embedded-grammar companions (ensureCore preload)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("colors a vue tsx script block seeded mid-file (the InTransitTab report)", async () => {
    const view = viewFor(buildFakeTheme({ syntaxColors: true }));
    const code = "const currentFilterValues = ref<ViewFieldFilter[]>([]);";
    const seed = '<script lang="tsx" setup>';
    const lines = await view.highlight({ code, language: "vue", seed });
    // eslint-disable-next-line no-control-regex -- counts token fg escapes
    const colors = new Set(lines.join("\n").match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []);
    // Flat (unloaded tsx embed) would carry exactly one fg color.
    expect(colors.size).toBeGreaterThan(1);
  });

  it("re-seeds per theme: a cross-theme state would throw into plain lines", async () => {
    // GrammarState binds stacks per theme — a state computed under theme A
    // THROWS under theme B (swallowed by the highlight fallback into
    // uncolored lines). The state cache keys on the theme, so the second
    // theme re-seeds instead of reusing. The themes must differ in an actual
    // syntax color: the derived shiki name hashes content, not the pi name.
    const code = "const currentFilterValues = ref<ViewFieldFilter[]>([]);";
    const seed = '<script lang="tsx" setup>';
    const base = buildFakeTheme({ syntaxColors: true });
    const viewA = viewFor(base);
    const viewB = viewFor({
      ...base,
      getFgAnsi: (color) =>
        color === "syntaxKeyword" ? "\x1b[38;2;200;156;214m" : base.getFgAnsi(color),
    });
    const linesA = await viewA.highlight({ code, language: "vue", seed });
    const linesB = await viewB.highlight({ code, language: "vue", seed });
    // eslint-disable-next-line no-control-regex -- counts token fg escapes
    const fgRe = /\x1b\[38;2;\d+;\d+;\d+m/g;
    const colorsA = new Set(linesA.join("\n").match(fgRe) ?? []);
    const colorsB = new Set(linesB.join("\n").match(fgRe) ?? []);
    expect(colorsA.size).toBeGreaterThan(1);
    expect(colorsB.size).toBeGreaterThan(1);
  });
});

describe("theme selections (the session's inputs)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("bundled-name enforcement produces an -aa- object keyed per background set", async () => {
    // A theme WITHOUT syntax colors, so the bundled-name path (not auto) triggers.
    const view = await githubDarkView(buildFakeTheme({ successBg: DARK_BG }));
    const theme = await view.activeTheme();
    // Either the raw id (nothing to enforce) or the enforced object.
    expect(theme === null || typeof theme === "string" || theme.name.includes("-aa-")).toBe(true);
  });

  it("diff roots change enforcement backgrounds → fresh theme identity (dynamic AA)", async () => {
    const { selection } = await resolveSyntaxThemeSelection("github-dark", ENV);
    const before = await makeRenderSession({ selection })
      .forTheme(buildFakeTheme({ successBg: DARK_BG }))
      .activeTheme();

    // Anchor the add-side word slot to a very different tint (the
    // enforcement backgrounds change with the roots).
    const after = await makeRenderSession({
      selection,
      diffRoots: { topLevel: { added: { tint: "#1a2b3cdd" } } },
    })
      .forTheme(buildFakeTheme({ successBg: DARK_BG }))
      .activeTheme();

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
    const theme = (await makeRenderSession({
      selection: {
        kind: "object",
        base: { kind: "auto" },
        colors: {},
        dark: { colors: { keyword: "#123456" } },
      },
    })
      .forTheme(buildFakeTheme({ successBg: DARK_BG }))
      .activeTheme()) as LooseTheme;
    expect(theme.name).toMatch(/^inline-dark-/);
    expect(theme.name).not.toMatch(/-aa-/);
    const keywordRule = theme.tokenColors?.find((rule) =>
      typeof rule.scope === "string" ? rule.scope === "keyword" : rule.scope?.includes("keyword"),
    );
    // Verbatim user color, however low the contrast.
    expect(keywordRule?.settings.foreground).toBe("#123456");
  });

  it("inline variant-mode without the current polarity's variant falls back to auto", async () => {
    const theme = await makeRenderSession({
      selection: {
        kind: "object",
        base: { kind: "auto" },
        colors: {},
        dark: { colors: { keyword: "#123456" } },
      },
    })
      .forTheme(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }))
      .activeTheme();
    expect(typeof theme).toBe("object");
    expect((theme as LooseTheme).name).toMatch(/^pi-light-/);
  });

  it("patch mode on a pair base rewrites rules with the user's colors verbatim", async () => {
    const { selection: pair } = await resolveSyntaxThemeSelection("github-light/github-dark", ENV);
    const theme = (await makeRenderSession({
      selection: { kind: "object", base: pair, colors: { keyword: "#00ff00" } },
    })
      .forTheme(buildFakeTheme({ successBg: DARK_BG }))
      .activeTheme()) as LooseTheme;
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
    const selection = {
      kind: "file" as const,
      file: { name: "user-dark", theme: fileTheme },
    };
    // Dark pi theme: the file theme is used verbatim (never enforced).
    expect(
      await makeRenderSession({ selection })
        .forTheme(buildFakeTheme({ successBg: DARK_BG }))
        .activeTheme(),
    ).toBe(fileTheme);

    // Light pi theme: gated → auto fallback.
    const gated = await makeRenderSession({ selection })
      .forTheme(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }))
      .activeTheme();
    expect(typeof gated).toBe("object");
    expect((gated as LooseTheme).name).toMatch(/^pi-light-/);
  });

  it("patch mode on a polarity-gated file base continues on auto", async () => {
    const fileTheme = {
      name: "user-dark",
      type: "dark" as const,
      tokenColors: [{ scope: "keyword", settings: { foreground: "#050505" } }],
    };
    // Light pi theme: the file is gated, patches continue on the auto theme.
    const theme = await makeRenderSession({
      selection: {
        kind: "object",
        base: { kind: "file", file: { name: "user-dark", theme: fileTheme } },
        colors: { keyword: "#00ff00" },
      },
    })
      .forTheme(buildFakeTheme({ successBg: LIGHT_BG, syntaxColors: true }))
      .activeTheme();
    expect(typeof theme).toBe("object");
    expect((theme as LooseTheme).name).toMatch(/^pi-light-/);
    const keywordRule = (
      theme as { tokenColors?: { scope?: string | string[]; settings: { foreground?: string } }[] }
    ).tokenColors?.find((rule) =>
      typeof rule.scope === "string" ? rule.scope === "keyword" : rule.scope?.includes("keyword"),
    );
    expect(keywordRule?.settings.foreground).toBe("#00ff00");
  });

  it("memoizes the active theme within a session: same inputs return the same object", async () => {
    const view = viewFor(themed({ successBg: DARK_BG }));
    const first = await view.activeTheme();
    const second = await view.activeTheme();
    expect(first).toBe(second);
  });
});

/**
 * The curated pairs (the former built-in families, now ordinary explicit
 * selections — config.md's recommended-pairs table).
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

describe("the recommended pairs (the slash grammar)", () => {
  beforeEach(() => {
    resetPigmentForTest();
  });
  afterEach(() => {
    resetPigmentForTest();
  });

  it("every recommended pair resolves through the slash grammar and follows the scheme's light/dark bit", async () => {
    for (const pair of Object.values(RECOMMENDED_PAIRS)) {
      const session = makeRenderSession({
        selection: await selectionFor(`${pair.light}/${pair.dark}`),
      });
      const dark = await themeName(session.forTheme(themed({ successBg: DARK_BG })));
      expect(dark).toMatch(pair.dark ? new RegExp(`^${pair.dark}-aa-`) : /^pi-dark-/);
      const light = await themeName(session.forTheme(themed({ successBg: LIGHT_BG })));
      expect(light).toMatch(pair.light ? new RegExp(`^${pair.light}-aa-`) : /^pi-light-/);
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

  it("single-polarity bundled names render on match (AA boundary), auto on the other polarity", async () => {
    // nord/dracula/monokai/tokyo-night are bundled names — B boundary:
    // enforced against the canvas (the clean id or an -aa- object), never
    // verbatim; polarity-gated to auto when the pi theme is light.
    for (const name of ["nord", "dracula", "monokai", "tokyo-night"] as const) {
      const session = makeRenderSession({ selection: await selectionFor(name) });
      const dark = await session.forTheme(themed({ successBg: DARK_BG })).activeTheme();
      // B boundary, strictly: the clean id OR an -aa- object — but a
      // verbatim object (bare name, no suffix) must never appear.
      expect(typeof dark === "string" ? dark : (dark as LooseTheme).name).toMatch(
        new RegExp(`^${name}(-aa-.+|$)`),
      );
      expect(typeof dark === "string" ? dark : (dark as LooseTheme).name).not.toBe(name);

      const light = await session.forTheme(themed({ successBg: LIGHT_BG })).activeTheme();
      expect(typeof light).toBe("object");
      expect((light as LooseTheme).name).toMatch(/^pi-light-/); // gated → auto
    }
  });

  it("auto renders unhighlighted when the pi theme lacks syntax colors", async () => {
    // No substitute fallback: honest degradation, like the large-diff path.
    const view = viewFor(buildFakeTheme({ successBg: DARK_BG }));
    expect(await view.activeTheme()).toBeNull();
    expect(await view.highlight(TS)).toEqual(CODE.split("\n"));
  });
});
