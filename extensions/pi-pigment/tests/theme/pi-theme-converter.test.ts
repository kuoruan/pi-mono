/**
 * The converter's contract (ADR 0006): token-set completeness (pinned to
 * the documented 53+3), the structural invariants (canvas slots equal,
 * all-flat-hex), AA on the colors WE choose (semantic slots — the theme's
 * own fg stays verbatim, pi's own built-ins ship sub-AA texts too), and
 * golden values for solarized-light (the hand-verified reference theme).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { themeNames } from "@shikijs/themes";
import { describe, expect, expectTypeOf, it } from "vitest";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import {
  convertToPiTheme,
  PI_OPTIONAL_TOKENS,
  PI_REQUIRED_TOKENS,
  type PiThemeJson,
} from "#src/theme/pi-theme-converter.ts";

function channelLum(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexLum(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

function contrast(a: string, b: string): number {
  const la = hexLum(a);
  const lb = hexLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("convertToPiTheme: solarized-light golden values", () => {
  it("paints tool frames by status: pending transparent, success green-tinted", async () => {
    const theme = (await loadBundledTheme("solarized-light"))!;
    const { doc, issues } = convertToPiTheme(theme, "pigment-solarized-light");
    expect(issues).toEqual([]);
    expect(doc).toBeDefined();
    // editor.background #FDF6E3 → the canvas; pending stays pure canvas
    // (transparent — no status hint while a call streams); success takes
    // the polarity's green at the error tint's ratio (25% light).
    expect(doc!.colors.toolPendingBg).toBe("#fdf6e3");
    expect(doc!.colors.toolSuccessBg).toBe("#c4d8b8");
    // The theme's own fg lands verbatim (identity, not enforced).
    expect(doc!.colors.text).toBe("#657b83");
  });

  it("background slots tint the canvas (not the foreground — the gray-on-gray guard)", async () => {
    const theme = (await loadBundledTheme("solarized-light"))!;
    const { doc } = convertToPiTheme(theme, "pigment-solarized-light");
    const { colors } = doc!;
    // userMessageBg = canvas + 3% fg: #fdf6e3 + 3% #657b83 → #f8f2e0 —
    // a hair off the canvas, NOT near the fg (the inverted-mix bug this
    // pins: a 97%-fg background rendered gray-on-gray text).
    expect(colors.userMessageBg).toBe("#f8f2e0");
    // The theme declares its own editor.selectionBackground — adopted
    // verbatim over the computed tint (the mapping, not the 12% formula;
    // the fallback formula is pinned by the plain-fixture test below).
    expect(colors.selectedBg).toBe("#eee8d5"); // solarized's declared selection
    // And the fg ladder runs the OTHER way: muted = 70% fg + 30% canvas
    // (exact value — the ladder's direction is pinned by the number).
    expect(colors.muted).toBe("#93a0a0");
  });

  it("tints the error box by polarity — visible on light canvases, subtle on dark", async () => {
    const light = (await loadBundledTheme("solarized-light"))!;
    const dark = (await loadBundledTheme("solarized-dark"))!;
    const lightDoc = convertToPiTheme(light, "pigment-solarized-light").doc!;
    const darkDoc = convertToPiTheme(dark, "pigment-solarized-dark").doc!;
    // Golden blend: light canvas #fdf6e3 + 25% error #c62828. The light
    // polarity takes the STRONGER tint — 10% of the error red over a
    // near-white canvas reads as plain white in truecolor terminals (the
    // aborted-create frame looked white), so only light canvases raise
    // the ratio.
    expect(lightDoc.colors.toolErrorBg).toBe("#efc3b4");
    // The dark polarity keeps the original subtle 10% tint (#002b36 +
    // 10% #f8564e) — untouched by the polarity gate.
    expect(darkDoc.colors.toolErrorBg).toBe("#192f38");
  });

  it("keeps every semantic slot AA on the canvas", async () => {
    const theme = (await loadBundledTheme("solarized-light"))!;
    const { doc } = convertToPiTheme(theme, "pigment-solarized-light");
    const { colors } = doc!;
    for (const slot of [
      "success",
      "error",
      "warning",
      "accent",
      "toolDiffAdded",
      "toolDiffRemoved",
      "toolDiffContext",
    ]) {
      expect(contrast(colors[slot], colors.toolPendingBg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("rejects themes without a usable canvas", () => {
    const { doc, issues } = convertToPiTheme(
      { name: "no-bg", type: "dark", tokenColors: [] },
      "pigment-no-bg",
    );
    expect(doc).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("editor.background");
  });

  it("enforceAa: false keeps the chosen colors verbatim (the user channel)", () => {
    const theme = {
      name: "flat",
      type: "dark" as const,
      colors: { "editor.background": "#282c34" },
      // Nearly invisible on its own canvas — exactly the color the sweep
      // would nudge readable on the bundled ship path.
      tokenColors: [{ scope: "comment", settings: { foreground: "#2a2a2a" } }],
    };
    const off = convertToPiTheme(theme, "pigment-flat", { enforceAa: false }).doc!;
    expect(off.colors.syntaxComment).toBe("#2a2a2a");
    // The default keeps the sweep (the bundled ship path).
    const on = convertToPiTheme(theme, "pigment-flat").doc!;
    expect(on.colors.syntaxComment).not.toBe("#2a2a2a");
  });
});

describe("convertToPiTheme: syntax fallback ladder", () => {
  it("a theme without string tokens falls back to the neutral fg (no functional-green leak)", () => {
    const theme = {
      name: "no-string",
      type: "dark" as const,
      colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
      tokenColors: [],
    };
    const { doc } = convertToPiTheme(theme, "pigment-no-string", { enforceAa: false });
    // The string slot is a SYNTAX slot — its fallback belongs to the fg
    // ladder, not to the functional success hue (green is a status color).
    expect(doc!.colors.syntaxString).toBe("#abb2bf");
  });
});

describe("convertToPiTheme: theme-declared selection/find colors", () => {
  const themed = {
    name: "mapped",
    type: "dark" as const,
    colors: {
      "editor.background": "#282c34",
      "editor.foreground": "#abb2bf",
      "editor.selectionBackground": "#3e4451",
      "editor.findMatchBackground": "#515c6a",
      "editor.findMatchForeground": "#e06c75",
    },
    tokenColors: [],
  };

  it("adopts the theme's own selection/find colors verbatim (not enforced)", () => {
    // The default enforceAa: true path still keeps author colors verbatim
    // — the sweep targets OUR choices, never colors a theme declares.
    const { doc } = convertToPiTheme(themed, "pigment-mapped");
    expect(doc!.colors.selectedBg).toBe("#3e4451");
    expect(doc!.colors.searchMatchBg).toBe("#515c6a");
    expect(doc!.colors.searchMatchText).toBe("#e06c75");
  });

  it("falls back to the computed tints when the keys are absent or malformed", () => {
    const absent = convertToPiTheme(
      {
        name: "plain",
        type: "dark" as const,
        colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
        tokenColors: [],
      },
      "pigment-plain",
    ).doc!;
    // canvas + 12% fg, canvas + 20% fg, fg — the ladder fallbacks.
    expect(absent.colors.selectedBg).toBe("#383c45");
    expect(absent.colors.searchMatchBg).toBe("#424750");
    expect(absent.colors.searchMatchText).toBe("#abb2bf");

    const malformed = convertToPiTheme(
      {
        ...themed,
        colors: {
          ...themed.colors,
          "editor.selectionBackground": "not-a-color",
          "editor.findMatchBackground": "",
        },
      },
      "pigment-malformed",
    ).doc!;
    // Malformed values fall back silently (the fg ?? neutralFg precedent).
    expect(malformed.colors.selectedBg).toBe("#383c45");
    expect(malformed.colors.searchMatchBg).toBe("#424750");
    // The valid foreground survives alongside.
    expect(malformed.colors.searchMatchText).toBe("#e06c75");
  });
});

describe("convertToPiTheme: syntax extraction is broadest-scope", () => {
  it("the broadest declared scope wins its category, regardless of rule order", () => {
    const theme = {
      name: "broadest",
      type: "dark" as const,
      colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
      tokenColors: [
        // A narrow doc-comment exception FIRST — under first-wins it would
        // hijack the comment category; broadest-wins takes the later
        // broad `comment` (the author's category intent).
        { scope: "comment.block.documentation", settings: { foreground: "#569cd6" } },
        { scope: "comment", settings: { foreground: "#6a9955" } },
        // A narrow string exception AFTER the broad one — the broad
        // `string` stays (specifics deliberately defer).
        { scope: "string", settings: { foreground: "#ce9178" } },
        { scope: "string.quoted.single", settings: { foreground: "#d4d4d4" } },
      ],
    };
    const { doc } = convertToPiTheme(theme, "pigment-broadest", { enforceAa: false });
    expect(doc!.colors.syntaxComment).toBe("#6a9955");
    expect(doc!.colors.syntaxString).toBe("#ce9178");
  });

  it("equal-length tied scopes keep the first rule in file order", () => {
    const theme = {
      name: "tie",
      type: "dark" as const,
      colors: { "editor.background": "#282c34", "editor.foreground": "#abb2bf" },
      tokenColors: [
        { scope: "string.quoted", settings: { foreground: "#aaaaaa" } },
        { scope: "string.regexp", settings: { foreground: "#bbbbbb" } },
      ],
    };
    const { doc } = convertToPiTheme(theme, "pigment-tie", { enforceAa: false });
    expect(doc!.colors.syntaxString).toBe("#aaaaaa");
  });
});

describe("convertToPiTheme: token set and structure", () => {
  it("mirrors every token pi's floor types define (compile-time pin)", () => {
    // The floor's own vocabulary: its exported ThemeColor union plus the
    // bg slots extracted from the Theme class (the SDK's root does not
    // re-export ThemeBg). Every floor token must be mirrored by our
    // lists — the reverse (ours ⊋ floor) is allowed by design: the
    // converter emits a forward-compatible superset (scrollbarTrack
    // exists only in newer pi; older pi ignores the extra keys). When pi
    // adds/renames a token on the floor, this assertion fails with the
    // token named in the error.
    type PiTokenList = (typeof PI_REQUIRED_TOKENS)[number] | (typeof PI_OPTIONAL_TOKENS)[number];
    // Floor ⊆ ours: every token the floor's types define must be one of
    // ours (the reverse direction is deliberately unconstrained).
    expectTypeOf<ThemeColor | Parameters<Theme["bg"]>[0]>().toExtend<PiTokenList>();
  });

  it("emits exactly the documented 53 required + 3 optional tokens", async () => {
    const theme = (await loadBundledTheme("vitesse-dark"))!;
    const { doc } = convertToPiTheme(theme, "pigment-vitesse-dark");
    const emitted = Object.keys(doc!.colors).toSorted();
    const expected = [...PI_REQUIRED_TOKENS, ...PI_OPTIONAL_TOKENS].toSorted();
    expect(emitted).toEqual(expected);
  });

  it("produces flat 6-digit lowercase hex throughout (no vars, no 256, no defaults)", async () => {
    const theme = (await loadBundledTheme("github-dark"))!;
    const { doc } = convertToPiTheme(theme, "pigment-github-dark");
    for (const value of Object.values(doc!.colors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    // And the export section.
    for (const value of Object.values(doc!.export!)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("carries the pi schema URL and the registered name", async () => {
    const theme = (await loadBundledTheme("nord"))!;
    const { doc } = convertToPiTheme(theme, "pigment-nord");
    expect(doc!.$schema).toContain("theme-schema.json");
    expect(doc!.name).toBe("pigment-nord");
  });
});

describe("the generated themes/ directory (golden assets)", () => {
  it("holds one document per bundled theme, structurally valid", async () => {
    const files = (await readdir(join(import.meta.dirname, "..", "..", "themes"))).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files).toHaveLength(themeNames.length);
    for (const file of files) {
      const doc: PiThemeJson = JSON.parse(
        await readFile(join(import.meta.dirname, "..", "..", "themes", file), "utf-8"),
      );
      expect(doc.name).toBe(file.replace(/\.json$/, ""));
      expect(Object.keys(doc.colors).toSorted()).toEqual(
        [...PI_REQUIRED_TOKENS, ...PI_OPTIONAL_TOKENS].toSorted(),
      );
      expect(doc.colors.toolPendingBg).toBe(doc.export!.pageBg);
    }
  });

  it("is reproducible: in-test regeneration matches the committed bytes", async () => {
    const names = [...themeNames].toSorted();
    for (const name of names) {
      const theme = await loadBundledTheme(name);
      expect(theme).toBeDefined();
      const { doc } = convertToPiTheme(theme!, `pigment-${name}`);
      const file = join(import.meta.dirname, "..", "..", "themes", `pigment-${name}.json`);
      // Byte-level: the RAW file text must equal the generator's exact
      // form (2-space indent + trailing newline) — re-stringifying both
      // sides compares deep-equal only and never catches an indent or
      // trailing-newline drift (the generator's tab form drifted past
      // this test once already).
      expect(await readFile(file, "utf-8")).toBe(`${JSON.stringify(doc, null, "  ")}\n`);
    }
  });
});
