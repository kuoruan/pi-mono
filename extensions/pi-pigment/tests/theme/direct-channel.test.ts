import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { themeNames } from "@shikijs/themes";
import { describe, expect, it } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { renderUnified } from "#src/render/unified-view.ts";
import { flattenTranslucentTokens, loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { type LoadedThemeFile } from "#src/theme/theme-file.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import { buildFakeTheme, makeRenderSession } from "#test/fixtures.ts";

// FIXED virtual paths: this file does NOT mock node:fs, so the paths must
// exist nowhere on the host (a real /project or /agent would hijack
// direct-name resolution). Real-fs tests further down use temp dirs.
const ENV = { cwd: "/project", agentDir: "/agent" };

async function installDirect(name: string): Promise<LoadedThemeFile | undefined> {
  const { selection } = await resolveSyntaxThemeSelection(name, ENV);
  if (selection.kind !== "file") return undefined;
  return selection.file;
}

describe("bundled-intake contract", () => {
  it("concurrent loads share one import (dedupe) and settle identical themes", async () => {
    const [a, b] = await Promise.all([loadBundledTheme("vesper"), loadBundledTheme("vesper")]);
    expect(a).toEqual(b);
    expect(a?.name).toBe("vesper");
  });

  it("a failed load stays cached: the session does not retry", async () => {
    // Pinning the semantic DECISION (failures are session-scoped, not
    // retried) so a future "fix" has to argue with this test, not drift.
    const first = await loadBundledTheme("nonexistent-theme-xyz");
    expect(first).toBeUndefined();
    const second = await loadBundledTheme("nonexistent-theme-xyz");
    expect(second).toBeUndefined();
  });

  it("every themeNames entry loads with a usable polarity (upgrade-drift guard)", async () => {
    for (const name of themeNames) {
      const theme = await loadBundledTheme(name);
      expect(theme === undefined ? `load failed: ${name}` : theme).toBeDefined();
      expect(theme?.type === "light" || theme?.type === "dark" ? true : `bad type: ${name}`).toBe(
        true,
      );
    }
  });

  it("vitesse-black's 3-digit canvas flattens its 8-digit tokens (no gray fallback)", async () => {
    const theme = await loadBundledTheme("vitesse-black");
    expect(theme).toBeDefined();
    // The #000 canvas parses (shorthand expanded); every 8-digit token
    // color composited to 6-digit — the renderer's gray fallback never
    // triggers.
    expect(JSON.stringify(theme?.tokenColors)).not.toMatch(/#[0-9a-fA-F]{8}/);
  });

  it("flatten passes settings-less rules through by reference (no throw)", () => {
    const settingsLess = { scope: "x", settings: {} as { foreground?: string } };
    const theme = {
      name: "t",
      type: "dark" as const,
      colors: { "editor.background": "#101010" },
      tokenColors: [settingsLess, { scope: "y", settings: { foreground: "#ff7b72b3" } }],
    };
    const flattened = flattenTranslucentTokens(theme);
    // The no-foreground rule is untouched (same reference); the
    // translucent one composited onto the canvas.
    expect(flattened.tokenColors?.[0]).toBe(settingsLess);
    expect(flattened.tokenColors?.[1]?.settings?.foreground).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("direct-name render-time behavior", () => {
  it("polarity-gates like any file: a dark direct name falls back to auto on light", async () => {
    const file = await installDirect("vesper");
    expect(file?.theme.type).toBe("dark");
    // A session whose selection is the installed direct name, framed with
    // a LIGHT pi theme: the polarity gate falls through to auto.
    const { selection } = await resolveSyntaxThemeSelection("vesper", ENV);
    const onLight = await makeRenderSession({ selection })
      .forTheme(buildFakeTheme({ successBg: "\x1b[48;2;250;250;250m" }))
      .activeTheme();
    // Whatever auto resolves to (an id, an object, or null when the fake
    // theme cannot derive), it is never vesper — the gate held.
    const identity =
      onLight === null ? "null" : typeof onLight === "string" ? onLight : onLight.name;
    expect(identity).not.toMatch(/vesper/);
  });

  it("renders AA-enforced on matching polarity — translucent tokens flattened to 6-digit", async () => {
    const file = await installDirect("vesper");
    expect(file).toBeDefined();
    const { selection } = await resolveSyntaxThemeSelection("vesper", ENV);
    const onDark = await makeRenderSession({ selection }).forTheme(buildFakeTheme()).activeTheme();
    // B boundary: a bundled name enforces against the effective
    // backgrounds — the enforced object carries the -aa- identity (or the
    // clean id when nothing needed enforcement; vesper on this fake dark
    // canvas does).
    expect(onDark !== null && typeof onDark !== "string" ? onDark.name : onDark).toMatch(
      /^vesper-aa-/,
    );
    // The TOKEN rules carry no 8-digit foregrounds (the renderer's 6-digit
    // contract) — the colors dict's translucent UI keys (diffEditor tints)
    // are untouched by design: only tokenColors flatten.
    expect(
      onDark !== null && typeof onDark !== "string" ? JSON.stringify(onDark.tokenColors) : "",
    ).not.toMatch(/#[0-9a-fA-F]{8}/);
  });
});

describe("roots spec (the merge matrix)", () => {
  it("a variant's diff roots ride the spec per-polarity", async () => {
    const { rootsSpec } = await resolveSyntaxThemeSelection(
      {
        base: "catppuccin-latte/catppuccin-mocha",
        dark: { base: "nord", diff: { removed: { text: "#123456" } } },
      },
      ENV,
    );
    expect(rootsSpec?.dark?.removed?.text).toBe("#123456");
    expect(rootsSpec?.topLevel).toBeUndefined();
  });
});

describe("direct-name shadowing and normalization edges", () => {
  it("a direct name shadows a same-named user file with a warning", async () => {
    // warnIfShadowed probes the REAL filesystem (existsSync) — a temp dir,
    // not memfs.
    const agentDir = mkdtempSync(join(tmpdir(), "pigment-shadow-"));
    const themesDir = join(agentDir, "extensions", "pigment", "themes");
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(
      join(themesDir, "vesper.json"),
      JSON.stringify({ name: "user-vesper", type: "dark", tokenColors: [] }),
    );
    const { selection, issues } = await resolveSyntaxThemeSelection("vesper", {
      cwd: "/project",
      agentDir,
    });
    // The BUNDLED vesper won (its canvas), not the user's file (no colors).
    expect(selection.kind === "file" && selection.file.theme.colors?.["editor.background"]).toBe(
      "#101010",
    );
    expect(issues.map((i) => i.message).join("\n")).toMatch(/shadow/i);
  });

  it("a user FILE keeps its 3-digit editor.background verbatim (the converter normalizes)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pigment-shorty-"));
    const themesDir = join(agentDir, "extensions", "pigment", "themes");
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(
      join(themesDir, "shorty.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        colors: { "editor.background": "#fff" },
      }),
    );
    const { selection } = await resolveSyntaxThemeSelection("shorty", {
      cwd: "/project",
      agentDir,
    });
    // ADR 0006: the 3-digit shorthand normalizes at MATERIALIZATION
    // (the converter's canvas parse), not into a roots spec.
    if (selection.kind !== "file") throw new Error("unreachable");
    expect(selection.file.theme.colors?.["editor.background"]).toBe("#fff");
    expect(selection.kind === "file" && selection.file.diffRoots).toBeUndefined();
  });

  it("direct-name e2e bytes: the override renders on the pi canvas", async () => {
    const { selection } = await resolveSyntaxThemeSelection("github-dark", ENV);
    const view = makeRenderSession({ selection }).forTheme(buildFakeTheme());
    const diff = parseDiff("const a = 1;\n", "const a = 2;\n");
    const out = await renderUnified({
      diff,
      language: undefined,
      maxLines: 20,
      width: 120,
      view,
      indicator: "bar",
    });
    // ADR 0006: the override layer renders TOKEN colors; the box canvas
    // stays the pi theme's (the fake's toolSuccessBg, 30;30;40 — NOT
    // github-dark's #24292e).
    expect(out).toContain("\x1b[48;2;30;30;40m");
    expect(out).not.toContain("\x1b[48;2;36;41;46m");
  });
});
