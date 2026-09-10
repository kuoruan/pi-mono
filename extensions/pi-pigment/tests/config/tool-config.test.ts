import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePatchFiles } from "#src/core/diff.ts";
import pigmentExtension from "#src/index.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

interface MockApi {
  on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => void) => void;
  registerTool: (tool: unknown) => void;
}

/** The tool-name vocabulary the fff-presence probe reads. */
const vocabulary = new Set<string>();
/** The command-name vocabulary (the order-safe fff signal). */
const commandVocabulary = new Set<string>();

/**
 * Run the extension against a mock API, firing session_start like pi does.
 *
 * @param pi - The mock API surface (on + registerTool collector).
 * @returns The mock API the extension bound to.
 */
async function startExtension(pi: {
  on: MockApi["on"];
  registerTool: (tool: never) => void;
}): Promise<MockApi> {
  let sessionStart: ((event: unknown, ctx: { cwd: string }) => void | Promise<void>) | undefined;
  const api = {
    on: (
      event: string,
      handler: (event: unknown, ctx: { cwd: string }) => void | Promise<void>,
    ) => {
      if (event === "session_start") sessionStart = handler;
    },
    registerTool: (tool: unknown) => pi.registerTool(tool as never),
    // Mirrors pi's surface: everything registered so far, by name.
    getAllTools: () => [...vocabulary].map((name) => ({ name })),
    // Commands register at module load (before session_start) — the
    // order-safe fff signal.
    getCommands: () => [...commandVocabulary].map((name) => ({ name })),
    registerCommand: (_name: string, _options: unknown) => {},
  };
  pigmentExtension(api as never);
  // The handler is async (bundled-theme direct names import lazily); pi's
  // runner awaits every handler — mirror that or the tools aren't there yet.
  await sessionStart?.({ type: "session_start", reason: "startup" }, { cwd: process.cwd() });
  return api;
}

/**
 * Seed the vocabulary as if another extension (e.g. pi-fff) had registered.
 *
 * @param names - The tool names to register.
 */
function seedVocabulary(names: string[]): void {
  for (const name of names) vocabulary.add(name);
}

describe("session_start re-registration (fork/resume)", () => {
  it("re-firing session_start on the same API replaces, never accumulates", async () => {
    // fork/resume re-fires session_start on the SAME extension instance;
    // the SDK's loader registers tools into a Map keyed by name, so the
    // re-registration replaces. The fixture mirrors that — assert the
    // mock's fidelity (seven names, no duplicates, twice fired).
    const api = {
      handlers: new Map<string, Array<(e: unknown, ctx: unknown) => void | Promise<void>>>(),
      tools: new Map<string, { name: string }>(),
      on(event: string, handler: (e: unknown, ctx: unknown) => void | Promise<void>) {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      registerTool(tool: { name: string }) {
        this.tools.set(tool.name, tool);
      },
      getAllTools() {
        return [...this.tools.values()];
      },
      getCommands: () => [] as Array<{ name: string }>,
      registerCommand(_name: string, _options: unknown) {},
    };
    await pigmentExtension(api as never);
    for (const reason of ["startup", "resume"]) {
      for (const h of api.handlers.get("session_start") ?? []) {
        await h({ type: "session_start", reason }, { cwd: "/tmp" });
      }
    }
    expect([...api.tools.keys()].toSorted()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "powershell",
      "write",
    ]);
    expect(api.tools.size).toBe(7); // no duplicates across the two fires
  });
});

describe("pi-fff compat (grep/find yield)", () => {
  // Order independence: the module-level vocabularies start empty, but
  // earlier tests in this file may have seeded them — clear before each
  // so no test depends on execution order.
  beforeEach(() => {
    vocabulary.clear();
    commandVocabulary.clear();
  });

  it("registers grep/find when no FFF vocabulary is present", async () => {
    const names: string[] = [];
    await startExtension({
      on: () => {},
      registerTool: (tool: { name: string }) => names.push(tool.name),
    });
    expect(names).toContain("grep");
    expect(names).toContain("find");
  });

  it("yields grep/find (keeps ls and the rest) when FFF tools are present", async () => {
    seedVocabulary(["ffgrep", "fffind", "fff-multi-grep"]);
    const names: string[] = [];
    await startExtension({
      on: () => {},
      registerTool: (tool: { name: string }) => names.push(tool.name),
    });
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).toContain("ls"); // FFF has no ls — pi-pigment stays
    expect(names).toContain("write");
    expect(names).toContain("bash");
  });

  it("yields on the fff-mode command alone (order-safe: vocabulary still empty)", async () => {
    // The real failure this pins: pi-pigment's session_start runs BEFORE
    // fff's, so the tool vocabulary is empty at probe time — only the
    // command signal (registered at module load) can see fff.
    vocabulary.clear();
    commandVocabulary.clear();
    commandVocabulary.add("fff-mode");
    const names: string[] = [];
    await startExtension({
      on: () => {},
      registerTool: (tool: { name: string }) => names.push(tool.name),
    });
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).toContain("ls");
  });

  it("registers grep/find again after the vocabulary is cleared", async () => {
    vocabulary.clear();
    commandVocabulary.clear();
    const names: string[] = [];
    await startExtension({
      on: () => {},
      registerTool: (tool: { name: string }) => names.push(tool.name),
    });
    expect(names).toContain("grep");
  });
});

async function registerEditTool() {
  const tools: Array<{
    name: string;
    execute: (...args: any[]) => Promise<any>;
    prepareArguments?: (input: any) => any;
  }> = [];
  await startExtension({
    on: () => {},
    registerTool: (tool: {
      name: string;
      execute: (...args: any[]) => Promise<any>;
      prepareArguments?: (input: any) => any;
    }) => tools.push(tool),
  });
  const edit = tools.find((tool) => tool.name === "edit");
  if (!edit) throw new Error("edit tool was not registered");
  return edit;
}

describe("disabledTools configuration", () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vol.reset();
    tempDir = "/tools-project";
    vol.mkdirSync(tempDir, { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    // Isolate the global config layer from the real ~/.pi.
    process.env.PI_CODING_AGENT_DIR = "/tools-agent";
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    delete process.env.PI_CODING_AGENT_DIR;
    vol.reset();
  });

  it("does not register edit when it is disabled", async () => {
    vol.mkdirSync(join(tempDir, ".pi/extensions/pigment"), { recursive: true });
    vol.writeFileSync(
      join(tempDir, ".pi/extensions/pigment/config.jsonc"),
      JSON.stringify({ disabledTools: ["edit"] }),
    );
    const registeredTools: string[] = [];

    await startExtension({
      on: () => {},
      registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
    });

    expect(registeredTools).toContain("write");
    expect(registeredTools).not.toContain("edit");
  });

  describe("edit safety contract", () => {
    it("rejects an ambiguous fuzzy match without changing the file", async () => {
      const file = join(tempDir, "ambiguous.ts");
      vol.writeFileSync(file, "foo\nfoo\n");
      const edit = await registerEditTool();

      await expect(
        edit.execute(
          "test",
          { path: file, edits: [{ oldText: "foo ", newText: "bar" }] },
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toThrow(/occurrences|unique/i);
      expect(vol.readFileSync(file, "utf8")).toBe("foo\nfoo\n");
    });

    it("counts occurrences the way the SDK does (non-overlapping)", async () => {
      const file = join(tempDir, "overlap-match.ts");
      vol.writeFileSync(file, "aaa");
      const edit = await registerEditTool();

      // 'aa' occurs once non-overlapping in 'aaa' (the SDK's own split-based
      // count) — the guard must not reject what the SDK accepts.
      await edit.execute(
        "test",
        { path: `@${file}`, edits: [{ oldText: "aa", newText: "X" }] },
        undefined,
        undefined,
        undefined,
      );
      expect(vol.readFileSync(file, "utf8")).toBe("Xa");

      // A genuinely duplicated block is rejected with guidance.
      const file2 = join(tempDir, "dup-match.ts");
      vol.writeFileSync(file2, "foo\nfoo\n");
      await expect(
        edit.execute(
          "test",
          { path: `@${file2}`, edits: [{ oldText: "foo", newText: "bar" }] },
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toThrow(/ambiguous|overlap|occurrences|unique/i);
      expect(vol.readFileSync(file2, "utf8")).toBe("foo\nfoo\n");
    });

    it("preserves BOM and CRLF for fuzzy edits", async () => {
      const file = join(tempDir, "crlf.ts");
      vol.writeFileSync(file, "\uFEFFheader\r\nfunction x() {\r\n    return 1;\r\n}\r\n");
      const edit = await registerEditTool();

      await edit.execute(
        "test",
        {
          path: file,
          edits: [
            {
              oldText: "function x() {\n    return 1;\n}",
              newText: "function x() {\n  return 2;\n}",
            },
          ],
        },
        undefined,
        undefined,
        undefined,
      );
      expect(vol.readFileSync(file, "utf8")).toBe(
        "\uFEFFheader\r\nfunction x() {\r\n  return 2;\r\n}\r\n",
      );
    });

    it("rejects overlapping edits matched against the original file", async () => {
      const file = join(tempDir, "overlap.ts");
      vol.writeFileSync(file, "abc");
      const edit = await registerEditTool();

      await expect(
        edit.execute(
          "test",
          {
            path: file,
            edits: [
              { oldText: "ab", newText: "abc" },
              { oldText: "bc", newText: "X" },
            ],
          },
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toThrow(/overlap/i);
      expect(vol.readFileSync(file, "utf8")).toBe("abc");
    });

    it("the SDK patch stashes the actually-matched source (verbatim details)", async () => {
      const file = join(tempDir, "preview.ts");
      vol.writeFileSync(file, "const x = 1;  \n");
      const edit = await registerEditTool();

      const result = await edit.execute(
        "test",
        { path: file, edits: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }] },
        undefined,
        undefined,
        undefined,
      );
      // execute no longer adapts details: the SDK's own patch text (the
      // source it actually matched, trailing spaces and all) rides along
      // for renderResult to parse lazily.
      const removed = parsePatchFiles(result.details?.patch ?? "")[0]?.lines.find(
        (line) => line.type === "del",
      );
      expect(removed?.content).toBe("const x = 1;  ");
    });

    it("keeps disjoint multi-edits in one original-file transaction", async () => {
      const file = join(tempDir, "multi.ts");
      vol.writeFileSync(file, "const a = 1;\nconst b = 2;\n");
      const edit = await registerEditTool();

      const result = await edit.execute(
        "test",
        {
          path: file,
          edits: [
            { oldText: "const a = 1;", newText: "const a = 10;" },
            { oldText: "const b = 2;", newText: "const b = 20;" },
          ],
        },
        undefined,
        undefined,
        undefined,
      );
      // The unified patch keeps both edits in one file-scoped diff; the
      // details stay in the SDK's own shape (no pi-pigment payload).
      const parsed = parsePatchFiles(result.details?.patch ?? "")[0];
      expect(parsed?.added).toBe(2);
      expect(result.details?.parsedDiff).toBeUndefined();
      expect(vol.readFileSync(file, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
    });
  });
});
