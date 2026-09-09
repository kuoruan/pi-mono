import { join } from "node:path";

/**
 * The `/pigment` command: the bare-invocation subcommand selector, the
 * convert path (theme selector + direct stem), argument completions
 * (subcommand names, then stems), and the headless guards.
 */
import { vol } from "memfs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { registerPigmentCommand } from "#src/command/theme-command.ts";
import { writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

const cwd = "/project";

/** The registered command's options (handler + completions), captured. */
// The SDK's CommandOptions shape is optional/Promise-union; the capture
// extracts the sync completions and the handler at registration instead of
// mirroring the type.
let complete!: (prefix: string) => { value: string; label: string }[] | null;
let stderr: string[];
let notified: string[];
let dialogues: { title: string; options: string[] }[];
let consoleSpy: ReturnType<typeof vi.spyOn>;
let cwdSpy: ReturnType<typeof vi.spyOn>;

/**
 * Run the registered handler once. Headless by default (stderr visible);
 * `selects` is a queue of select answers (undefined = cancel that dialog).
 */
let run!: (
  args: string,
  opts?: { hasUI?: boolean; selects?: (string | undefined)[] },
) => Promise<void>;

const THEMES = join(cwd, ".pi", "extensions", "pigment", "themes");

/** The subcommand's picker row and completion label (`name — description`). */
const CONVERT_ROW = "convert — convert a TextMate theme file into a registered pi theme";

describe("/pigment", () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(THEMES, { recursive: true });
    stderr = [];
    notified = [];
    dialogues = [];
    consoleSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      stderr.push(parts.join(" "));
    });
    // The completions build their env from process.cwd() — the REAL cwd,
    // not the test's /project. Pin it so the memfs project layer shows up.
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    registerPigmentCommand({
      registerCommand: (_name, registered) => {
        complete = (prefix) =>
          (registered.getArgumentCompletions?.(prefix) ?? null) as
            | {
                value: string;
                label: string;
              }[]
            | null;
        run = (args, runOpts = {}) =>
          registered.handler(args, {
            hasUI: runOpts.hasUI ?? false,
            cwd,
            ui: {
              select: async (title: string, choices: string[]) => {
                dialogues.push({ title, options: choices });
                return (runOpts.selects ?? []).shift();
              },
              notify: (message: string) => {
                notified.push(message);
              },
            },
          } as never);
      },
    });
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it("converts a named stem directly and reports the output", async () => {
    writeFile(
      join(THEMES, "mine.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [{ scope: "keyword", settings: { foreground: "#61afef" } }],
        colors: { "editor.background": "#282c34" },
      }),
    );
    await run("convert mine");
    expect(stderr.join("\n")).toMatch(/converted mine → themes\/pigment-mine\.json/);
    expect(stderr.join("\n")).toMatch(/\/reload to register/);
  });

  it("an unknown stem reports not-found guidance", async () => {
    await run("convert nope");
    expect(stderr.join("\n")).toMatch(/no theme source "nope"/);
  });

  it("convert with no candidates says so (headless)", async () => {
    await run("convert");
    expect(stderr.join("\n")).toMatch(/no theme sources to convert/);
  });

  it("unknown subcommands list the known ones", async () => {
    await run("whatever");
    expect(stderr.join("\n")).toMatch(/unknown subcommand "whatever" — known: convert/);
  });

  it("headless convert with candidates lists the stems instead of a selector", async () => {
    writeFile(
      join(THEMES, "a.json"),
      JSON.stringify({ type: "dark", tokenColors: [], colors: { "editor.background": "#111111" } }),
    );
    await run("convert");
    expect(stderr.join("\n")).toMatch(/headless mode — name a stem: a \(project\)/);
  });

  it("bare /pigment headless points at the direct form", async () => {
    await run("");
    expect(stderr.join("\n")).toMatch(/subcommand picker needs an interactive UI/);
  });

  it("bare /pigment in the UI opens the subcommand selector, then the theme selector, then converts", async () => {
    writeFile(
      join(THEMES, "mine.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [{ scope: "keyword", settings: { foreground: "#61afef" } }],
        colors: { "editor.background": "#282c34" },
      }),
    );
    await run("", { hasUI: true, selects: [CONVERT_ROW, "mine (project)"] });
    expect(dialogues).toEqual([
      { title: "pi-pigment — pick a subcommand", options: [CONVERT_ROW] },
      { title: "Convert theme", options: ["mine (project)"] },
    ]);
    expect(notified.join("\n")).toMatch(/converted mine → themes\/pigment-mine\.json/);
    expect(vol.existsSync(join(THEMES, "pigment-mine.json"))).toBe(true);
  });

  it("cancelling the subcommand selector does nothing", async () => {
    writeFile(
      join(THEMES, "mine.json"),
      JSON.stringify({ type: "dark", tokenColors: [], colors: { "editor.background": "#111111" } }),
    );
    await run("", { hasUI: true, selects: [undefined] });
    expect(dialogues).toEqual([
      { title: "pi-pigment — pick a subcommand", options: [CONVERT_ROW] },
    ]);
    expect(notified).toEqual([]);
    expect(vol.existsSync(join(THEMES, "pigment-mine.json"))).toBe(false);
  });

  it("cancelling the theme selector after picking a subcommand does nothing", async () => {
    writeFile(
      join(THEMES, "mine.json"),
      JSON.stringify({ type: "dark", tokenColors: [], colors: { "editor.background": "#111111" } }),
    );
    await run("", { hasUI: true, selects: [CONVERT_ROW, undefined] });
    expect(dialogues).toEqual([
      { title: "pi-pigment — pick a subcommand", options: [CONVERT_ROW] },
      { title: "Convert theme", options: ["mine (project)"] },
    ]);
    expect(notified).toEqual([]);
    expect(vol.existsSync(join(THEMES, "pigment-mine.json"))).toBe(false);
  });

  it("a direct /pigment convert in the UI reports through notify after the picker", async () => {
    writeFile(
      join(THEMES, "mine.json"),
      JSON.stringify({
        type: "dark",
        tokenColors: [{ scope: "keyword", settings: { foreground: "#61afef" } }],
        colors: { "editor.background": "#282c34" },
      }),
    );
    await run("convert", { hasUI: true, selects: ["mine (project)"] });
    expect(dialogues).toEqual([{ title: "Convert theme", options: ["mine (project)"] }]);
    expect(notified.join("\n")).toMatch(/converted mine → themes\/pigment-mine\.json/);
    expect(stderr).toEqual([]);
  });

  it("a direct /pigment convert with no candidates reports through notify", async () => {
    await run("convert", { hasUI: true });
    expect(notified.join("\n")).toMatch(/no theme sources to convert/);
  });

  it("a broken source surfaces its load issue before the picker (never a silent omission)", async () => {
    writeFile(join(THEMES, "broken.json"), "{ not json");
    writeFile(
      join(THEMES, "ok.json"),
      JSON.stringify({ type: "dark", tokenColors: [], colors: { "editor.background": "#111111" } }),
    );
    await run("convert", { hasUI: true, selects: ["ok (project)"] });
    // The load failure is reported, the healthy candidate still lists.
    expect(notified.join("\n")).toMatch(/not valid JSONC/);
    expect(dialogues).toEqual([{ title: "Convert theme", options: ["ok (project)"] }]);
  });

  describe("argument completions", () => {
    it("an empty prefix suggests the subcommand", () => {
      expect(complete("")).toEqual([{ value: "convert", label: CONVERT_ROW }]);
    });

    it("a partial subcommand name completes it", () => {
      expect(complete("c")).toEqual([{ value: "convert", label: CONVERT_ROW }]);
      expect(complete("con")).toEqual([{ value: "convert", label: CONVERT_ROW }]);
    });

    it("a non-matching word returns null (subcommand and foreign words alike)", () => {
      expect(complete("convertx")).toBeNull();
      expect(complete("x")).toBeNull();
      expect(complete("nope ")).toBeNull();
    });

    it("after the convert subcommand, stem completions replace the whole args", () => {
      writeFile(
        join(THEMES, "a.json"),
        JSON.stringify({
          type: "dark",
          tokenColors: [],
          colors: { "editor.background": "#111111" },
        }),
      );
      writeFile(
        join(THEMES, "b.json"),
        JSON.stringify({
          type: "dark",
          tokenColors: [],
          colors: { "editor.background": "#222222" },
        }),
      );
      writeFile(
        join(THEMES, "mine.json"),
        JSON.stringify({
          type: "dark",
          tokenColors: [],
          colors: { "editor.background": "#333333" },
        }),
      );
      const all = complete("convert ")!
        .map((item) => item.value)
        .toSorted();
      expect(all).toEqual(["convert a", "convert b", "convert mine"]);
      expect(complete("convert m")).toEqual([{ value: "convert mine", label: "convert mine" }]);
      expect(complete("convert x")).toBeNull();
    });
  });
});
