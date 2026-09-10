import { bundledThemes } from "shiki";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";
import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { resolveDiffPalette, resetPaletteForTest, setDiffRoots } from "#src/theme/palette.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import { resolveActiveTheme, setSyntaxThemeSelection } from "#src/theme/theme-selection.ts";
import { buildFakeTheme, resetPigmentForTest } from "#test/fixtures.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

const AGENT_DIR = "/agent";
const CWD = "/project";
// The agent dir needs no extra `.pi` segment (it already ends in it).
const GLOBAL_THEMES = `${AGENT_DIR}/extensions/pigment/themes`;
const PROJECT_THEMES = `${CWD}/.pi/extensions/pigment/themes`;

/** A minimal valid dark theme file. */
const DARK_THEME = {
  type: "dark",
  colors: { "editor.foreground": "#abb2bf" },
  tokenColors: [{ scope: "keyword", settings: { foreground: "#c678dd" } }],
};

/** A minimal valid .tmTheme (the original XML plist form). */
const TM_THEME_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>name</key>
	<string>Monokai</string>
	<key>settings</key>
	<array>
		<dict>
			<key>settings</key>
			<dict>
				<key>background</key>
				<string>#272822</string>
			</dict>
		</dict>
		<dict>
			<key>scope</key>
			<string>keyword</string>
			<key>settings</key>
			<dict>
				<key>foreground</key>
				<string>#66D9EF</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>`;

function env() {
  return { cwd: CWD, agentDir: AGENT_DIR };
}

beforeEach(() => {
  vol.reset();
});

describe("theme file materialization", () => {
  it("flattens 8-digit token colors onto the file theme's own canvas", async () => {
    writeFile(`${GLOBAL_THEMES}/translucent.jsonc`, {
      name: "translucent",
      type: "dark",
      colors: { "editor.background": "#10141c" },
      tokenColors: [
        { scope: "punctuation", settings: { foreground: "#bfbdb6b3" } },
        { scope: "keyword", settings: { foreground: "#ff7b72" } },
      ],
    });
    const { selection } = await resolveSyntaxThemeSelection("translucent", env());
    expect(selection.kind).toBe("file");
    if (selection.kind !== "file") return;
    const tc =
      (
        selection.file.theme as {
          tokenColors?: {
            scope?: string | readonly string[];
            settings?: { foreground?: string };
          }[];
        }
      ).tokenColors ?? [];
    const punct = tc.find((r) => r.settings?.foreground?.length === 7);
    // The 8-digit value composited onto the theme's own canvas (#10141c),
    // not passed through to the renderer's gray fallback.
    expect(punct?.settings?.foreground?.toLowerCase()).toBe("#8b8b88");
    // Opaque values pass through untouched.
    expect(tc.find((r) => r.scope === "keyword")?.settings?.foreground?.toLowerCase()).toBe(
      "#ff7b72",
    );
  });
  it("a file's diffRoots carry the explicit diff key verbatim (the converter's input)", async () => {
    writeFile(`${PROJECT_THEMES}/explicit-roots.json`, {
      ...DARK_THEME,
      colors: { "editor.background": "#0d1117" },
      diff: { added: { text: "#101a20" } },
    });
    const { selection } = await resolveSyntaxThemeSelection("explicit-roots", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    // ADR 0006: the roots ride the file's diffRoots — the converter
    // decides what the tints become, not the palette.
    expect(selection.file.diffRoots).toEqual({ added: { text: "#101a20" } });
  });
});

describe("string resolution", () => {
  it("resolves auto and a slash pair without file access", async () => {
    expect((await resolveSyntaxThemeSelection("auto", env())).selection).toEqual({ kind: "auto" });
    const pair = await resolveSyntaxThemeSelection("catppuccin-latte/catppuccin-mocha", env());
    expect(pair.selection.kind).toBe("pair");
    expect(pair.issues).toEqual([]);
  });

  it("resolves theme files from the global layer", async () => {
    writeFile(`${GLOBAL_THEMES}/my-theme.json`, DARK_THEME);
    const { selection, issues, rootsSpec } = await resolveSyntaxThemeSelection("my-theme", env());
    expect(selection.kind).toBe("file");
    expect(issues).toEqual([]);
    expect(rootsSpec).toBeUndefined(); // no diff key in the file
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(selection.file.theme.type).toBe("dark");
    expect(selection.file.theme.tokenColors?.[0]?.settings?.foreground).toBe("#c678dd");
  });

  it("resolves .jsonc files and extracts the diff extension key", async () => {
    writeFile(
      `${PROJECT_THEMES}/mine.jsonc`,
      `// comment\n{ "type": "dark", "tokenColors": [], "diff": {"added": { "text": "#3fb950" }} }`,
    );
    const { selection, rootsSpec } = await resolveSyntaxThemeSelection("mine", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    // ADR 0006: file diff keys ride the selection (the converter's
    // input), never the palette's roots spec.
    expect(selection.file.diffRoots).toEqual({ added: { text: "#3fb950" } });
    expect(rootsSpec).toBeUndefined();
  });

  it("reports and drops non-hex diff root values", async () => {
    writeFile(
      `${PROJECT_THEMES}/badroots.jsonc`,
      `{ "type": "dark", "tokenColors": [], "diff": {"added": { "text": "red" }, "removed": { "tint": "#ok" }} }`,
    );
    const { selection, rootsSpec, issues } = await resolveSyntaxThemeSelection("badroots", env());
    expect(selection.kind).toBe("file");
    expect(rootsSpec).toBeUndefined();
    expect(issues.map((i) => i.message).join("\n")).toMatch(/added\.text.*opaque #rrggbb/s);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/removed\.tint.*#rrggbbaa.*ignored/s);
  });

  it("materialization flattens 8-digit token colors onto the theme canvas", async () => {
    // ayu carries translucent punctuation (#bfbdb6b3 etc.) — every
    // 6-digit consumer downstream (AA enforcement, our ANSI renderer)
    // needs it pre-composited over the theme's own editor.background.
    const ayu = await loadBundledTheme("ayu-dark");
    expect(ayu).toBeDefined();
    const translucent = ayu!.tokenColors?.find((rule) => rule.settings?.foreground === "#bfbdb6b3");
    expect(translucent).toBeUndefined(); // flattened away
    const flat = ayu!.tokenColors?.find((rule) => rule.settings?.foreground === "#8b8b88");
    expect(flat).toBeDefined(); // 0xbfbdb6b3 over #10141c
    // Opaque themes pass through untouched (no editor.background guess).
    const nord = await loadBundledTheme("nord");
    const original = bundledThemes.nord;
    const nordRaw = (await original()).default ?? (await original());
    expect(nord?.tokenColors?.length).toBe(nordRaw.tokenColors?.length);
  });

  it("rejects translucent FOREGROUND roots with an issue (ADR 0003)", async () => {
    // Foregrounds never composite — an 8-digit fg root is meaningless.
    // The tint root rides along (the next assertion).
    writeFile(
      `${PROJECT_THEMES}/tintfg.jsonc`,
      `{ "type": "dark", "tokenColors": [], "diff": {"added": { "text": "#3fb95080" }, "removed": { "tint": "#f8514966" }} }`,
    );
    const { selection, rootsSpec, issues } = await resolveSyntaxThemeSelection("tintfg", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/added\.text.*opaque #rrggbb.*ignored/s);
    // The bg tint rides the file's diffRoots; only the fg root was dropped.
    expect(selection.file.diffRoots).toEqual({ removed: { tint: "#f8514966" } });
    expect(rootsSpec).toBeUndefined();
  });

  it("lets project files shadow same-named global files", async () => {
    writeFile(`${GLOBAL_THEMES}/dupe.json`, DARK_THEME);
    writeFile(`${PROJECT_THEMES}/dupe.json`, { ...DARK_THEME, type: "light" });
    const { selection } = await resolveSyntaxThemeSelection("dupe", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(selection.file.theme.type).toBe("light");
  });

  it("warns when a file is shadowed by a bundled name (or auto)", async () => {
    writeFile(`${GLOBAL_THEMES}/github-dark.json`, DARK_THEME);
    writeFile(`${PROJECT_THEMES}/auto.json`, DARK_THEME);
    const direct = await resolveSyntaxThemeSelection("github-dark", env());
    expect(direct.selection.kind).toBe("file");
    expect(direct.issues.map((i) => i.message).join("\n")).toMatch(/shadowed/);

    const auto = await resolveSyntaxThemeSelection("auto", env());
    expect(auto.issues.map((i) => i.message).join("\n")).toMatch(/shadowed/);
  });

  it("conversion never retires the source; the product name points at /theme", async () => {
    writeFile(`${PROJECT_THEMES}/mine.json`, DARK_THEME);
    writeFile(`${PROJECT_THEMES}/pigment-mine.json`, { name: "pigment-mine", colors: {} });
    // The source stem keeps working — the token override stays available.
    const source = await resolveSyntaxThemeSelection("mine", env());
    expect(source.selection).toEqual({
      kind: "file",
      file: expect.objectContaining({ name: "mine" }),
    });
    expect(source.issues).toEqual([]);
    // The product (a pi-theme JSON) is not a Shiki theme — a directed issue.
    const product = await resolveSyntaxThemeSelection("pigment-mine", env());
    expect(product.selection).toEqual({ kind: "auto" });
    expect(product.issues.map((i) => i.message).join("\n")).toMatch(/\/settings → Theme/);
  });

  it("a converted half keeps working in its pair position (conversion retires nothing)", async () => {
    writeFile(`${PROJECT_THEMES}/pair-light.json`, { ...DARK_THEME, type: "light" });
    writeFile(`${PROJECT_THEMES}/pair-dark.json`, DARK_THEME);
    writeFile(`${PROJECT_THEMES}/pigment-pair-light.json`, {
      name: "pigment-pair-light",
      colors: {},
    });
    const { selection, issues } = await resolveSyntaxThemeSelection("pair-light/pair-dark", env());
    expect(selection.kind).toBe("pair");
    if (selection.kind !== "pair") throw new Error("unreachable");
    expect(selection.light?.name).toBe("pair-light");
    expect(selection.dark?.name).toBe("pair-dark");
    expect(issues).toEqual([]);
  });

  it("slash-grammar edges: empty halves, double slash, and auto as a half", async () => {
    // Empty halves.
    const emptyLight = await resolveSyntaxThemeSelection("github-dark/", env());
    expect(emptyLight.selection).toEqual({ kind: "auto" });
    expect(emptyLight.issues.map((i) => i.message).join("\n")).toMatch(/empty pair half/);
    const emptyDark = await resolveSyntaxThemeSelection("/github-dark", env());
    expect(emptyDark.selection).toEqual({ kind: "auto" });
    expect(emptyDark.issues.map((i) => i.message).join("\n")).toMatch(/empty pair half/);
    // More than one slash.
    const doubled = await resolveSyntaxThemeSelection("a/b/c", env());
    expect(doubled.selection).toEqual({ kind: "auto" });
    expect(doubled.issues.map((i) => i.message).join("\n")).toMatch(/more than one/);
    // "auto" is not a half — the missing-polarity fallback to auto is
    // implicit; the OTHER half still pairs (that polarity falls to auto).
    const autoHalf = await resolveSyntaxThemeSelection("auto/github-dark", env());
    expect(autoHalf.selection.kind).toBe("pair");
    if (autoHalf.selection.kind !== "pair") throw new Error("unreachable");
    expect(autoHalf.selection.light).toBeUndefined();
    expect(autoHalf.selection.dark?.name).toBe("github-dark");
    expect(autoHalf.issues.map((i) => i.message).join("\n")).toMatch(/not valid as a pair half/);
  });

  it("slash-grammar halves trim; a position-type mismatch issues instead of silently never rendering", async () => {
    writeFile(`${PROJECT_THEMES}/trim-light.json`, { ...DARK_THEME, type: "light" });
    writeFile(`${PROJECT_THEMES}/trim-dark.json`, DARK_THEME);
    const trimmed = await resolveSyntaxThemeSelection(" trim-light / trim-dark ", env());
    expect(trimmed.issues).toEqual([]);
    expect(trimmed.selection.kind).toBe("pair");
    if (trimmed.selection.kind !== "pair") throw new Error("unreachable");
    expect(trimmed.selection.light?.name).toBe("trim-light");
    expect(trimmed.selection.dark?.name).toBe("trim-dark");

    // Reversed halves: github-dark carries type "dark" in the light position.
    const reversed = await resolveSyntaxThemeSelection("github-dark/github-light", env());
    expect(reversed.selection.kind).toBe("pair");
    const msgs = reversed.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/light half "github-dark".*can never render from the light position/s);
    expect(msgs).toMatch(/dark half "github-light".*can never render from the dark position/s);
  });

  it("falls back to auto with an issue for unresolvable names", async () => {
    const { selection, issues } = await resolveSyntaxThemeSelection("nord-light", env());
    expect(selection).toEqual({ kind: "auto" });
    expect(issues.map((i) => i.message).join("\n")).toMatch(/nord-light/);
  });

  it("skips invalid theme files with ONE issue each (the parse failure, never a false 'not found')", async () => {
    writeFile(`${GLOBAL_THEMES}/no-type.json`, { tokenColors: [] });
    writeFile(`${GLOBAL_THEMES}/no-rules.json`, { type: "dark" });
    writeFile(`${GLOBAL_THEMES}/broken.json`, `{ nope`);

    for (const name of ["no-type", "no-rules", "broken"]) {
      const { selection, issues } = await resolveSyntaxThemeSelection(name, env());
      expect(selection).toEqual({ kind: "auto" });
      // Exactly the parse issue — a found-but-unparsable file must not
      // ALSO report "matches no themes/ file" (B1's regression pin).
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).not.toMatch(/matches no/);
    }
  });
});

describe("object resolution", () => {
  it("variant mode carries variants with an auto base", async () => {
    const { selection, rootsSpec } = await resolveSyntaxThemeSelection(
      { dark: { colors: { keyword: "#ff0000" } } },
      env(),
    );
    expect(selection).toEqual({
      kind: "object",
      base: { kind: "auto" },
      colors: {},
      dark: { colors: { keyword: "#ff0000" } },
    });
    expect(rootsSpec).toBeUndefined();
  });

  it("patch mode resolves the base and merges the file's diff under the object's", async () => {
    writeFile(`${GLOBAL_THEMES}/themed.json`, {
      ...DARK_THEME,
      diff: { added: { text: "#111111" } },
    });
    const { selection, rootsSpec } = await resolveSyntaxThemeSelection(
      {
        base: "themed",
        diff: { removed: { text: "#222222" } },
        dark: { diff: { added: { text: "#333333" } } },
      },
      env(),
    );
    if (selection.kind !== "object") throw new Error("unreachable");
    expect(selection.base.kind).toBe("file");
    // ADR 0006: only the OBJECT's own diff keys are roots; the file's
    // ride the selection (the converter consumes them).
    expect(rootsSpec).toEqual({
      topLevel: { removed: { text: "#222222" } },
      dark: { added: { text: "#333333" } },
    });
  });

  it("patch mode on a slash-pair base keeps the object's colors", async () => {
    const { selection, rootsSpec } = await resolveSyntaxThemeSelection(
      { base: "catppuccin-latte/catppuccin-mocha", colors: { keyword: "#ff7b72" } },
      env(),
    );
    if (selection.kind !== "object") throw new Error("unreachable");
    expect(selection.base.kind).toBe("pair");
    expect(selection.colors).toEqual({ keyword: "#ff7b72" });
    // ADR 0006: the canvas is the CONVERTER's business (the registered pi
    // theme's slots) — the override selects tokens only.
    expect(rootsSpec).toBeUndefined();
  });

  it("an unresolvable base falls back to auto with an issue, patches continue", async () => {
    const { selection, issues } = await resolveSyntaxThemeSelection(
      { base: "does-not-exist", colors: { keyword: "#ff7b72" } },
      env(),
    );
    if (selection.kind !== "object") throw new Error("unreachable");
    expect(selection.base).toEqual({ kind: "auto" });
    expect(selection.colors).toEqual({ keyword: "#ff7b72" });
    expect(issues.map((i) => i.message).join("\n")).toMatch(/does-not-exist/);
  });
});

describe("VS Code colors passthrough (ADR 0003)", () => {
  it("extracts bg roots from the colors dict's diffEditor keys zero-config", async () => {
    writeFile(
      `${PROJECT_THEMES}/vscodey.json`,
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        colors: {
          "editor.background": "#0d1117",
          "diffEditor.insertedTextBackground": "#3fb9504d",
          "diffEditor.removedTextBackground": "#ff7b724d",
          "editorGutter.addedBackground": "#2ea04366",
        },
      }),
    );
    const { selection, issues, rootsSpec } = await resolveSyntaxThemeSelection("vscodey", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(issues).toEqual([]);
    // ADR 0006: the passthrough tints ride the file's diffRoots (the
    // converter's input); the canvas is editor.background itself.
    expect(selection.file.diffRoots).toEqual({
      added: { tint: "#3fb9504d" },
      removed: { tint: "#ff7b724d" },
    });
    expect(rootsSpec).toBeUndefined();
  });

  it("applies per side (an inserted-only colors dict roots only inserted)", async () => {
    writeFile(
      `${PROJECT_THEMES}/one-sided.json`,
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        colors: { "diffEditor.insertedTextBackground": "#3fb9504d" },
      }),
    );
    const { selection } = await resolveSyntaxThemeSelection("one-sided", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(selection.file.diffRoots).toEqual({ added: { tint: "#3fb9504d" } });
  });

  it("the explicit diff key wins per-key over the passthrough", async () => {
    writeFile(
      `${PROJECT_THEMES}/both.json`,
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        colors: {
          "diffEditor.insertedTextBackground": "#3fb9504d",
          "diffEditor.removedTextBackground": "#ff7b724d",
        },
        diff: { added: { tint: "#00ff8866" } },
      }),
    );
    const { selection } = await resolveSyntaxThemeSelection("both", env());
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(selection.file.diffRoots).toEqual({
      added: { tint: "#00ff8866" }, // explicit wins
      removed: { tint: "#ff7b724d" }, // passthrough fills
    });
  });

  it("ignores all other VS Code diff keys (gutter/line/border/move)", async () => {
    writeFile(
      `${PROJECT_THEMES}/noisy.json`,
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        colors: {
          "diffEditor.insertedLineBackground": "#23863626",
          "editorGutter.addedBackground": "#2ea04366",
          "editorGutter.deletedBackground": "#f8514966",
          "diffEditor.border": "#30363d",
        },
      }),
    );
    const { rootsSpec } = await resolveSyntaxThemeSelection("noisy", env());
    expect(rootsSpec).toBeUndefined();
  });

  it("produces an issue for unknown diff keys", async () => {
    writeFile(
      `${PROJECT_THEMES}/typo.json`,
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        diff: { "diffEditor.insertedTextBackground": "#3fb9504d", addedFg: "#ff0000" },
      }),
    );
    const { issues } = await resolveSyntaxThemeSelection("typo", env());
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toMatch(/Unknown diff key "diffEditor\.insertedTextBackground"/);
    expect(messages).toMatch(/Unknown diff key "addedFg"/);
  });

  it("end-to-end: a user config tint anchors the word slot over the pi canvas", async () => {
    // ADR 0006: the file channel's tints ride the converter (generation
    // time); the USER's config tints remain the palette's roots — this
    // e2e pins that surviving path with the real github-dark values.
    setDiffRoots({
      topLevel: { added: { tint: "#3fb9504d" }, removed: { tint: "#ff7b724d" } },
    });
    resetPaletteForTest();
    try {
      // Fake pi theme: dark canvas (13,17,23) ≈ github-dark's #0d1117.
      const palette = resolveDiffPalette(
        buildFakeTheme({
          successBg: "\x1b[48;2;13;17;23m",
          errorBg: "\x1b[48;2;13;17;23m",
        }),
      );
      // Word slot = composite(#3fb950 at 77/255 over #0d1117) = (28,68,40).
      expect(palette.bgAddedWord).toBe("\x1b[48;2;28;68;40m");
      // Line slot = alpha/2 = the author's own 15% line intent → (21,42,32).
      expect(palette.bgAdded).toBe("\x1b[48;2;21;42;32m");
      // The canvas stays the pi theme's — context rows untouched.
      expect(palette.bgBase).toBe("\x1b[48;2;13;17;23m");
    } finally {
      resetPigmentForTest();
    }
  });
});

describe("TextMate JSON themes (the tm-themes package shape)", () => {
  const TM_THEME = {
    name: "Monokai Classic",
    settings: [
      { settings: { background: "#272822", foreground: "#f8f8f2" } },
      { scope: "comment", settings: { foreground: "#75715e" } },
      { scope: "keyword, storage.type", settings: { foreground: "#f92672", fontStyle: "italic" } },
    ],
  };

  it("converts the settings array and infers polarity from the global background", async () => {
    writeFile(`${PROJECT_THEMES}/monokai-classic.json`, TM_THEME);
    const { selection, issues } = await resolveSyntaxThemeSelection("monokai-classic", env());
    expect(issues).toHaveLength(0);
    expect(selection.kind).toBe("file");
    if (selection.kind !== "file") return;
    // Dark background (#272822) → dark polarity, inferred.
    expect(selection.file.theme.type).toBe("dark");
    // Rules pass through; the comma scope string survives verbatim
    // (vscode-textmate splits it at match time).
    expect(selection.file.theme.tokenColors).toHaveLength(2);
    expect(selection.file.theme.tokenColors?.[1]?.scope).toBe("keyword, storage.type");
    // The global entry became the editor colors downstream code reads.
    expect(selection.file.theme.colors?.["editor.background"]).toBe("#272822");
    expect(selection.file.theme.colors?.["editor.foreground"]).toBe("#f8f8f2");
  });

  it("infers light polarity from a light global background", async () => {
    writeFile(`${PROJECT_THEMES}/light-tm.json`, {
      settings: [
        { settings: { background: "#fafafa" } },
        { scope: "comment", settings: { foreground: "#888888" } },
      ],
    });
    const { selection, issues } = await resolveSyntaxThemeSelection("light-tm", env());
    expect(issues).toHaveLength(0);
    expect(selection.kind === "file" && selection.file.theme.type).toBe("light");
  });

  it("still extracts the diff extension key from a tm-shaped file", async () => {
    writeFile(`${PROJECT_THEMES}/tm-diff.json`, {
      ...TM_THEME,
      diff: { removed: { text: "#101a20" }, added: { tint: "#3fb95066" } },
    });
    const { selection, issues } = await resolveSyntaxThemeSelection("tm-diff", env());
    expect(issues).toHaveLength(0);
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(selection.file.diffRoots).toEqual({
      removed: { text: "#101a20" },
      added: { tint: "#3fb95066" },
    });
  });

  it("skips a tm theme with no global background (no polarity to infer)", async () => {
    writeFile(`${PROJECT_THEMES}/no-bg.json`, {
      settings: [{ scope: "comment", settings: { foreground: "#75715e" } }],
    });
    const { selection, issues } = await resolveSyntaxThemeSelection("no-bg", env());
    expect(selection.kind).toBe("auto");
    expect(issues.map((i) => i.message).join("\n")).toMatch(
      /needs an opaque #rrggbb global background/,
    );
  });

  it("tolerates the tm-themes extra keys (displayName, semanticTokenColors)", async () => {
    writeFile(`${PROJECT_THEMES}/modern.json`, {
      name: "Andromeeda",
      displayName: "Andromeeda",
      type: "dark",
      semanticTokenColors: { variable: "#ff0000" },
      colors: { "editor.background": "#23262e" },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#c678dd" } }],
    });
    const { selection, issues } = await resolveSyntaxThemeSelection("modern", env());
    expect(issues).toHaveLength(0);
    expect(selection.kind).toBe("file");
  });

  it("a .tmTheme file loads through the file channel (the native plist intake)", async () => {
    writeFile(`${PROJECT_THEMES}/plist-theme.tmTheme`, TM_THEME_PLIST);
    const { selection, issues } = await resolveSyntaxThemeSelection("plist-theme", env());
    expect(issues).toHaveLength(0);
    expect(selection.kind).toBe("file");
  });

  it("a .tmTheme renamed to .json is reported as invalid JSON (the extension decides)", async () => {
    writeFile(`${PROJECT_THEMES}/renamed.json`, TM_THEME_PLIST);
    const { selection, issues } = await resolveSyntaxThemeSelection("renamed", env());
    expect(selection.kind).toBe("auto");
    expect(issues.map((i) => i.message).join("\n")).toMatch(/not valid JSONC/);
  });
});

describe("per-polarity variant bases (user theme pairs)", () => {
  it("resolves each variant's base to its own themes/ file", async () => {
    writeFile(`${PROJECT_THEMES}/pair-light.json`, {
      type: "light",
      tokenColors: [{ scope: "keyword", settings: { foreground: "#aa0000" } }],
    });
    writeFile(`${PROJECT_THEMES}/pair-dark.json`, {
      type: "dark",
      tokenColors: [{ scope: "keyword", settings: { foreground: "#00aa00" } }],
    });
    const { selection, issues } = await resolveSyntaxThemeSelection(
      { light: { base: "pair-light" }, dark: { base: "pair-dark" } },
      env(),
    );
    expect(issues).toHaveLength(0);
    expect(selection.kind).toBe("object");
    if (selection.kind !== "object") return;
    expect(selection.light?.base?.kind).toBe("file");
    expect(selection.dark?.base?.kind).toBe("file");
  });

  it("pairs tm-JSON files by inferred polarity", async () => {
    writeFile(`${PROJECT_THEMES}/tm-pair-light.json`, {
      settings: [
        { settings: { background: "#fafafa", foreground: "#333333" } },
        { scope: "keyword", settings: { foreground: "#888888" } },
      ],
    });
    writeFile(`${PROJECT_THEMES}/tm-pair-dark.json`, {
      settings: [
        { settings: { background: "#101010", foreground: "#cccccc" } },
        { scope: "keyword", settings: { foreground: "#888888" } },
      ],
    });
    const { selection, issues } = await resolveSyntaxThemeSelection(
      { light: { base: "tm-pair-light" }, dark: { base: "tm-pair-dark" } },
      env(),
    );
    expect(issues).toHaveLength(0);
    if (selection.kind !== "object") return;
    const lightFile = selection.light?.base;
    const darkFile = selection.dark?.base;
    expect(lightFile?.kind === "file" && lightFile.file.theme.type).toBe("light"); // inferred
    expect(darkFile?.kind === "file" && darkFile.file.theme.type).toBe("dark"); // inferred
  });

  it("a variant base composes with that variant's color patches", async () => {
    writeFile(`${PROJECT_THEMES}/patched-base.json`, DARK_THEME);
    const { selection, issues } = await resolveSyntaxThemeSelection(
      { dark: { base: "patched-base", colors: { keyword: "#ff00ff" } } },
      env(),
    );
    expect(issues).toHaveLength(0);
    setSyntaxThemeSelection(selection);
    const active = await resolveActiveTheme(resolveDiffPalette(buildFakeTheme()), buildFakeTheme());
    const tc =
      (active as { tokenColors?: { settings?: { foreground?: string } }[] }).tokenColors ?? [];
    expect(tc.some((r) => r.settings?.foreground?.toLowerCase() === "#ff00ff")).toBe(true);
  });

  it("an empty variant with only diff roots stays valid (base optional)", async () => {
    const { selection, issues } = await resolveSyntaxThemeSelection(
      { base: "auto", dark: { diff: { added: { tint: "#3fb95066" } } } },
      env(),
    );
    expect(issues).toHaveLength(0);
    expect(selection.kind).toBe("object");
  });

  it("a variant with none of base/colors/diff is rejected", async () => {
    const bad = configSchema.safeParse({ syntaxTheme: { dark: {} } });
    expect(bad.success).toBe(false);
  });
});

describe("file pairs (the explicit slash grammar)", () => {
  it("pairs user files by their explicit halves", async () => {
    writeFile(`${PROJECT_THEMES}/pair2-light.json`, { ...DARK_THEME, type: "light" });
    writeFile(`${PROJECT_THEMES}/pair2-dark.json`, DARK_THEME);
    const { selection, issues } = await resolveSyntaxThemeSelection(
      "pair2-light/pair2-dark",
      env(),
    );
    expect(issues).toHaveLength(0);
    expect(selection.kind).toBe("pair");
    if (selection.kind !== "pair") return;
    expect(selection.light?.theme.type).toBe("light");
    expect(selection.dark?.theme.type).toBe("dark");
  });

  it("the bare stem no longer discovers a pair — it is a single name now", async () => {
    writeFile(`${PROJECT_THEMES}/pair3-light.json`, { ...DARK_THEME, type: "light" });
    writeFile(`${PROJECT_THEMES}/pair3-dark.json`, DARK_THEME);
    const { selection, issues } = await resolveSyntaxThemeSelection("pair3", env());
    expect(selection).toEqual({ kind: "auto" });
    expect(issues.map((i) => i.message).join("\n")).toMatch(/no Shiki-bundled theme/);
  });

  it("a single dark-only name falls back to auto on the light polarity at render", async () => {
    writeFile(`${PROJECT_THEMES}/solo-dark.json`, DARK_THEME);
    const { selection } = await resolveSyntaxThemeSelection("solo-dark", env());
    expect(selection.kind).toBe("file");
    setSyntaxThemeSelection(selection);
    // Light terminal + dark-only pair → the auto path (null here — the fake
    // theme has no syntax colors to derive from), NEVER the dark half's
    // colors; dark terminal uses the half.
    const onLight = await resolveActiveTheme(
      resolveDiffPalette(buildFakeTheme({ successBg: "\x1b[48;2;250;250;250m" })),
      buildFakeTheme({ successBg: "\x1b[48;2;250;250;250m" }),
    );
    expect(onLight === null || !JSON.stringify(onLight).includes("#c678dd")).toBe(true);
    const onDark = await resolveActiveTheme(resolveDiffPalette(buildFakeTheme()), buildFakeTheme());
    expect(JSON.stringify(onDark)).toContain("#c678dd"); // DARK_THEME's keyword
  });

  it("an exact file wins over a same-stem pair", async () => {
    writeFile(`${PROJECT_THEMES}/exact.json`, DARK_THEME);
    writeFile(`${PROJECT_THEMES}/exact-light.json`, { ...DARK_THEME, type: "light" });
    const { selection } = await resolveSyntaxThemeSelection("exact", env());
    expect(selection.kind).toBe("file");
  });

  it("a pair referenced as a variant base picks its half at render", async () => {
    writeFile(`${PROJECT_THEMES}/vp-light.json`, { ...DARK_THEME, type: "light" });
    writeFile(`${PROJECT_THEMES}/vp-dark.json`, DARK_THEME);
    const { selection } = await resolveSyntaxThemeSelection(
      { dark: { base: "vp-light/vp-dark" } },
      env(),
    );
    expect(selection.kind).toBe("object");
    setSyntaxThemeSelection(selection);
    const onDark = await resolveActiveTheme(resolveDiffPalette(buildFakeTheme()), buildFakeTheme());
    expect(JSON.stringify(onDark)).toContain("#c678dd");
  });
});

describe("direct bundled-theme names (the @shikijs/themes channel)", () => {
  it("a direct name resolves as a virtual file — verbatim, its diff roots riding the selection", async () => {
    const { selection, rootsSpec, issues } = await resolveSyntaxThemeSelection(
      "vitesse-dark",
      env(),
    );
    expect(issues).toEqual([]);
    expect(selection.kind === "file" && selection.file.name).toBe("vitesse-dark");
    expect(selection.kind === "file" && selection.file.theme.type).toBe("dark");
    // ADR 0006: the canvas is the CONVERTER's input (editor.background
    // itself), the native diffEditor tints ride diffRoots — the override
    // selects tokens only, never the palette's roots.
    expect(selection.kind === "file" && selection.file.diffRoots?.added?.tint).toBe("#4d937550");
    expect(selection.kind === "file" && selection.file.diffRoots?.removed?.tint).toBe("#ab595950");
    expect(rootsSpec).toBeUndefined();
  });

  it("a direct name with diffEditor colors passes them through zero-config", async () => {
    // solarized-dark carries no diffEditor keys; pick one that does
    // (github-dark's diffEditor.insertedTextBackground).
    const { selection } = await resolveSyntaxThemeSelection("github-dark", env());
    expect(selection.kind === "file" && selection.file.diffRoots?.added?.tint).toMatch(
      /^#[0-9a-fA-F]{8}$/,
    );
  });

  it("a direct name as an object base: the object's own diff keys are the roots", async () => {
    const { rootsSpec } = await resolveSyntaxThemeSelection(
      { base: "vesper", diff: { added: { tint: "#3fb95066" } } },
      env(),
    );
    // ADR 0006: only the OBJECT's own diff keys are roots; the base's
    // canvas/diff roots ride the selection (the converter's input).
    expect(rootsSpec).toEqual({ topLevel: { added: { tint: "#3fb95066" } } });
  });

  it("an unknown name still falls back to auto with an issue (direct names do not swallow typos)", async () => {
    const { selection, issues } = await resolveSyntaxThemeSelection("solarize-light", env());
    expect(selection.kind).toBe("auto");
    expect(issues.map((i) => i.message).join("\n")).toMatch(/solarize-light/);
  });

  it("the former family shorthand now resolves through the slash grammar", async () => {
    // "vitesse" alone is no longer a curated family — it matches nothing
    // (issue + auto); the pair spelling is the way.
    const shorthand = await resolveSyntaxThemeSelection("vitesse", env());
    expect(shorthand.selection).toEqual({ kind: "auto" });
    expect(shorthand.issues.map((i) => i.message).join("\n")).toMatch(/vitesse/);
    const pair = await resolveSyntaxThemeSelection("vitesse-light/vitesse-dark", env());
    expect(pair.selection.kind).toBe("pair");
    expect(pair.issues).toEqual([]);
  });
});
