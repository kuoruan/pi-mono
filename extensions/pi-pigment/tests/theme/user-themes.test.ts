import { existsSync, readFileSync } from "node:fs";
/**
 * The custom-theme channel (ADR 0006, manual form): sources in the config
 * themes/ directories, conversion ONLY through convertThemes (the
 * /pigment convert command's engine), outputs landing next to their
 * sources, the retirement rule (pigment-X.json exists → source X retires
 * from the selectable channels), and the resources_discover product
 * (listing + registry).
 */
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PiThemeJson } from "#src/theme/pi-theme-converter.ts";
import type { ThemeEnv } from "#src/theme/theme-file.ts";
import { registeredSourceOf, resetRegistryForTest } from "#src/theme/theme-registry.ts";
import {
  convertThemes,
  listConvertCandidateEntries,
  listConvertCandidates,
  listConvertedThemes,
  loadUserTheme,
  outputFileName,
  piNameForUserStem,
  registerConvertedThemes,
} from "#src/theme/user-themes.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

const cwd = "/project";
const agentDir = "/agent";
const projectThemes = (): string => join(cwd, ".pi", "extensions", "pigment", "themes");
const globalThemes = (): string => join(agentDir, "extensions", "pigment", "themes");

/** A minimal valid dark theme source. */
const DARK_SOURCE = JSON.stringify({
  type: "dark",
  tokenColors: [{ scope: "keyword", settings: { foreground: "#61afef" } }],
  colors: { "editor.background": "#282c34" },
});

/** A minimal valid .tmTheme (the original XML plist form). */
const TM_THEME_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
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

describe("the manual conversion channel", () => {
  beforeEach(() => {
    resetRegistryForTest();
    vol.reset();
    vol.mkdirSync(projectThemes(), { recursive: true });
    vol.mkdirSync(globalThemes(), { recursive: true });
  });
  afterEach(() => {
    resetRegistryForTest();
  });

  it("converts a source into a pigment-*.json output NEXT TO it", () => {
    writeFile(join(projectThemes(), "mine.json"), DARK_SOURCE);
    const { results, issues } = convertThemes({ cwd, agentDir }, ["mine"]);
    expect(issues).toEqual([]);
    expect(results).toEqual([{ ok: true, stem: "mine" }]);
    const out = join(projectThemes(), outputFileName("mine"));
    expect(existsSync(out)).toBe(true);
    const doc = JSON.parse(readFileSync(out, "utf-8")) as PiThemeJson;
    expect(doc.name).toBe("pigment-mine");
    expect(doc.colors.toolPendingBg).toBe("#282c34"); // the canvas, baked
  });

  it("retires a converted source: it leaves the candidate list and the file's diff roots ride the output", () => {
    writeFile(
      join(projectThemes(), "rooted.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [],
        colors: { "editor.background": "#101a20" },
        diff: { added: { text: "#1a7f37" } },
      }),
    );
    expect(listConvertCandidates({ cwd, agentDir })).toEqual(["rooted"]);
    convertThemes({ cwd, agentDir }, ["rooted"]);
    // Retired: not a candidate anymore.
    expect(listConvertCandidates({ cwd, agentDir })).toEqual([]);
    const doc = JSON.parse(
      readFileSync(join(projectThemes(), "pigment-rooted.json"), "utf-8"),
    ) as PiThemeJson;
    expect(doc.colors.toolPendingBg).toBe("#101a20"); // the AUTHOR's canvas
    // Un-retire: delete the output.
  });

  it("not-found for unknown or already-converted stems", () => {
    writeFile(join(projectThemes(), "mine.json"), DARK_SOURCE);
    convertThemes({ cwd, agentDir }, ["mine"]);
    const again = convertThemes({ cwd, agentDir }, ["mine"]);
    expect(again.results).toEqual([{ ok: false, stem: "mine", reason: "not-found" }]);
    expect(convertThemes({ cwd, agentDir }, ["nope"]).results).toEqual([
      { ok: false, stem: "nope", reason: "not-found" },
    ]);
  });

  it("refuses a bundled-name collision with an issue", () => {
    writeFile(join(projectThemes(), "nord.json"), DARK_SOURCE);
    const { results, issues } = convertThemes({ cwd, agentDir }, ["nord"]);
    expect(results).toEqual([{ ok: false, stem: "nord", reason: "invalid" }]);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/collides with a bundled theme/);
    expect(existsSync(join(projectThemes(), "pigment-nord.json"))).toBe(false);
  });

  it("listConvertedThemes returns the outputs (project shadows global by stem)", () => {
    writeFile(join(globalThemes(), "shared.json"), DARK_SOURCE);
    convertThemes({ cwd, agentDir }, ["shared"]);
    // A same-stem project output shadows the global one.
    writeFile(
      join(projectThemes(), "pigment-shared.json"),
      JSON.stringify({ name: "pigment-shared", colors: {} }),
    );
    const listed = listConvertedThemes({ cwd, agentDir });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toBe(join(projectThemes(), "pigment-shared.json"));
  });

  it("registerConvertedThemes maps output+source pairs to the precise pipeline", () => {
    writeFile(join(projectThemes(), "mine.json"), DARK_SOURCE);
    convertThemes({ cwd, agentDir }, ["mine"]);
    registerConvertedThemes({ cwd, agentDir });
    expect(registeredSourceOf("pigment-mine")).toEqual({ kind: "user", fileName: "mine" });
    // loadUserTheme reloads the SOURCE (full tokenColors precision).
    expect(loadUserTheme("mine", { cwd, agentDir })?.name).toBe("mine");
  });

  it("an output WITHOUT its source stays an external theme (no registry entry)", () => {
    writeFile(
      join(projectThemes(), "pigment-orphan.json"),
      JSON.stringify({ name: "pigment-orphan", colors: {} }),
    );
    registerConvertedThemes({ cwd, agentDir });
    expect(registeredSourceOf("pigment-orphan")).toBeUndefined();
  });

  it("an invalid source (no tokenColors) is not convertable — issue, no output", () => {
    writeFile(join(projectThemes(), "bad.json"), JSON.stringify({ type: "dark" }));
    const { results, issues } = convertThemes({ cwd, agentDir }, ["bad"]);
    // An unloadable source never enters the candidate map: not-found.
    expect(results).toEqual([{ ok: false, stem: "bad", reason: "not-found" }]);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/tokenColors/);
    expect(existsSync(join(projectThemes(), "pigment-bad.json"))).toBe(false);
  });

  it("project sources shadow same-named global sources", () => {
    writeFile(join(globalThemes(), "dupe.json"), DARK_SOURCE);
    writeFile(
      join(projectThemes(), "dupe.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [{ scope: "comment", settings: { foreground: "#7f848e" } }],
        colors: { "editor.background": "#1b1b1b" },
      }),
    );
    convertThemes({ cwd, agentDir }, ["dupe"]);
    const doc = JSON.parse(
      readFileSync(join(projectThemes(), "pigment-dupe.json"), "utf-8"),
    ) as PiThemeJson;
    expect(doc.colors.toolPendingBg).toBe("#1b1b1b"); // the PROJECT source won
  });

  it("outputs never appear as sources (pigment-*.json excluded from scans)", () => {
    writeFile(join(projectThemes(), "mine.json"), DARK_SOURCE);
    convertThemes({ cwd, agentDir }, ["mine"]);
    // The output exists alongside the source; the candidate list is empty
    // (mine retired) and the output itself never becomes a candidate.
    expect(listConvertCandidates({ cwd, agentDir })).toEqual([]);
  });

  it("piNameForUserStem sanitizes path-hostile characters", () => {
    expect(piNameForUserStem("my theme!")).toBe("pigment-my-theme-");
  });

  it("the candidate entries annotate each source's config layer (global first, project merged in)", () => {
    writeFile(join(globalThemes(), "global-one.json"), DARK_SOURCE);
    writeFile(join(projectThemes(), "project-one.json"), DARK_SOURCE);
    const { entries, issues } = listConvertCandidateEntries({ cwd, agentDir });
    expect(issues).toEqual([]);
    expect(entries).toEqual([
      { stem: "global-one", layer: "global" },
      { stem: "project-one", layer: "project" },
    ]);
  });

  it("a global-only candidate is annotated global", () => {
    writeFile(join(globalThemes(), "global-only.json"), DARK_SOURCE);
    const { entries } = listConvertCandidateEntries({ cwd, agentDir });
    expect(entries).toEqual([{ stem: "global-only", layer: "global" }]);
  });

  it("a same-named project source shadows the global one (one entry, project layer)", () => {
    writeFile(join(globalThemes(), "dupe.json"), DARK_SOURCE);
    writeFile(
      join(projectThemes(), "dupe.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [{ scope: "comment", settings: { foreground: "#7f848e" } }],
        colors: { "editor.background": "#1b1b1b" },
      }),
    );
    const { entries } = listConvertCandidateEntries({ cwd, agentDir });
    expect(entries).toEqual([{ stem: "dupe", layer: "project" }]);
  });

  it("a conversion OUTPUT anywhere retires the stem everywhere (per-stem across layers)", () => {
    // A global output retires a PROJECT source: the retirement evidence
    // from both layers merges BEFORE any source is filtered.
    writeFile(
      join(globalThemes(), "pigment-early.json"),
      JSON.stringify({ name: "pigment-early" }),
    );
    writeFile(join(projectThemes(), "early.json"), DARK_SOURCE);
    expect(listConvertCandidates({ cwd, agentDir })).toEqual([]);
  });

  it("user conversion skips the AA sweep — author colors land verbatim", () => {
    writeFile(
      join(projectThemes(), "low-contrast.json"),
      JSON.stringify({
        type: "dark",
        // #2a2a2a comments on a #282c34 canvas are nearly invisible — the
        // bundled ship's sweep would nudge them readable; the USER channel
        // keeps them exactly (the enforcement boundary: user set = verbatim).
        tokenColors: [{ scope: "comment", settings: { foreground: "#2a2a2a" } }],
        colors: { "editor.background": "#282c34" },
        diff: { added: { text: "#9bf7b0" }, removed: { text: "#f7a45c" } },
      }),
    );
    convertThemes({ cwd, agentDir }, ["low-contrast"]);
    const doc = JSON.parse(
      readFileSync(join(projectThemes(), "pigment-low-contrast.json"), "utf-8"),
    ) as PiThemeJson;
    expect(doc.colors.syntaxComment).toBe("#2a2a2a");
    // The diff roots ride the same verbatim boundary (the converter's
    // single enforce closure covers them — pinned separately here).
    expect(doc.colors.toolDiffAdded).toBe("#9bf7b0");
    expect(doc.colors.toolDiffRemoved).toBe("#f7a45c");
  });

  it("a .tmTheme source is a convert candidate and converts through the same converter", () => {
    writeFile(join(projectThemes(), "plist-theme.tmTheme"), TM_THEME_PLIST);
    expect(listConvertCandidates({ cwd, agentDir })).toEqual(["plist-theme"]);
    const { results, issues } = convertThemes({ cwd, agentDir }, ["plist-theme"]);
    expect(issues).toEqual([]);
    expect(results).toEqual([{ ok: true, stem: "plist-theme" }]);
    const doc = JSON.parse(
      readFileSync(join(projectThemes(), "pigment-plist-theme.json"), "utf-8"),
    ) as PiThemeJson;
    expect(doc.colors.toolPendingBg).toBe("#272822"); // the plist's global background
  });

  /** A .tmTheme with selection/find global keys (the mapping-through case). */
  const TM_THEME_MAPPED_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>name</key>
	<string>Mapped</string>
	<key>settings</key>
	<array>
		<dict>
			<key>settings</key>
			<dict>
				<key>background</key>
				<string>#272822</string>
				<key>foreground</key>
				<string>#F8F8F2</string>
				<key>selection</key>
				<string>#49483E</string>
				<key>findHighlight</key>
				<string>#FFE792</string>
				<key>findHighlightForeground</key>
				<string>#000000</string>
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

  it("a .tmTheme's selection/findHighlight keys map through to the pi slots", () => {
    writeFile(join(projectThemes(), "mapped.tmTheme"), TM_THEME_MAPPED_PLIST);
    const { results, issues } = convertThemes({ cwd, agentDir }, ["mapped"]);
    expect(issues).toEqual([]);
    expect(results).toEqual([{ ok: true, stem: "mapped" }]);
    const doc = JSON.parse(
      readFileSync(join(projectThemes(), "pigment-mapped.json"), "utf-8"),
    ) as PiThemeJson;
    expect(doc.colors.selectedBg).toBe("#49483e");
    expect(doc.colors.searchMatchBg).toBe("#ffe792");
    expect(doc.colors.searchMatchText).toBe("#000000");
  });

  it("a malformed .tmTheme is skipped with an issue, never a crash", () => {
    writeFile(
      join(projectThemes(), "broken.tmTheme"),
      `<?xml version="1.0"?><plist><dict><key>name</key><string>x</string>`,
    );
    expect(listConvertCandidates({ cwd, agentDir })).toEqual([]);
    const { results, issues } = convertThemes({ cwd, agentDir }, ["broken"]);
    expect(results).toEqual([{ ok: false, stem: "broken", reason: "not-found" }]);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/plist/);
  });
});
