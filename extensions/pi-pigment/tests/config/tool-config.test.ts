import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePatchFiles } from "#src/core/diff.ts";
import { registerTools, toolOf } from "#test/fixtures.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

const tempDir = "/tools-project";

/** The eight names the resolver decorates with no foreign occupancy. */
const ALL_TOOLS = ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"];

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(tempDir, { recursive: true });
  // Isolate the global config layer from the real ~/.pi.
  process.env.PI_CODING_AGENT_DIR = "/tools-agent";
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  vol.reset();
});

describe("resolver stability across session_start re-fires", () => {
  it("decorates the same eight names on a re-fire (no accumulation, no self-shadow)", async () => {
    // fork/resume re-fires session_start on the SAME extension instance.
    // The resolver is registered once at load and reads the swapped kit, so
    // a re-fire returns the same triples — nothing registers, nothing
    // accumulates.
    const first = (await registerTools()).map((tool) => tool.name).toSorted();
    const second = (await registerTools()).map((tool) => tool.name).toSorted();
    expect(first).toEqual(ALL_TOOLS.toSorted());
    expect(second).toEqual(first);
  });
});

describe("pi-fff compat (grep/find yield)", () => {
  it("decorates grep/find when no FFF vocabulary is present", async () => {
    const names = (await registerTools()).map((tool) => tool.name);
    expect(names).toContain("grep");
    expect(names).toContain("find");
  });

  it("yields grep/find (keeps ls and the rest) when FFF tools are present", async () => {
    const names = (await registerTools({}, ["ffgrep", "fffind", "fff-multi-grep"])).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).toContain("ls"); // FFF has no ls — pi-pigment stays
    expect(names).toContain("write");
    expect(names).toContain("bash");
  });

  it("yields on the fff-mode command alone (order-safe: vocabulary still empty)", async () => {
    // The real failure this pins: pi-pigment's resolver may run before
    // fff's tools register, so the tool vocabulary is empty at probe time —
    // only the command signal (registered at module load) can see fff.
    const names = (await registerTools({}, [], undefined, ["fff-mode"])).map((tool) => tool.name);
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).toContain("ls");
  });

  it("decorates grep/find again after the vocabulary is cleared", async () => {
    const names = (await registerTools({}, [], undefined, [])).map((tool) => tool.name);
    expect(names).toContain("grep");
    expect(names).toContain("find");
  });
});

/**
 * The registered edit tool (or fails the test).
 *
 * @returns The edit tool.
 */
async function editTool() {
  return toolOf(await registerTools({ cwd: tempDir, agentDir: "/tools-agent" }), "edit");
}

describe("disabledTools configuration", () => {
  it("does not decorate edit when it is disabled", async () => {
    vol.mkdirSync(join(tempDir, ".pi/extensions/pigment"), { recursive: true });
    vol.writeFileSync(
      join(tempDir, ".pi/extensions/pigment/config.jsonc"),
      JSON.stringify({ disabledTools: ["edit"] }),
    );
    const names = (await registerTools({ cwd: tempDir, agentDir: "/tools-agent" })).map(
      (tool) => tool.name,
    );
    expect(names).toContain("write");
    expect(names).not.toContain("edit");
  });

  describe("edit safety contract", () => {
    it("rejects an ambiguous fuzzy match without changing the file", async () => {
      const file = join(tempDir, "ambiguous.ts");
      vol.writeFileSync(file, "foo\nfoo\n");
      const edit = await editTool();

      await expect(
        edit.execute!(
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
      const edit = await editTool();

      // 'aa' occurs once non-overlapping in 'aaa' (the SDK's own split-based
      // count) — the guard must not reject what the SDK accepts.
      await edit.execute!(
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
        edit.execute!(
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
      const edit = await editTool();

      await edit.execute!(
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
      const edit = await editTool();

      await expect(
        edit.execute!(
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
      const edit = await editTool();

      const result = await edit.execute!(
        "test",
        { path: file, edits: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }] },
        undefined,
        undefined,
        undefined,
      );
      // execute no longer adapts details: the SDK's own patch text (the
      // source it actually matched, trailing spaces and all) rides along
      // for renderResult to parse lazily.
      const details = result.details as { patch?: string } | undefined;
      const removed = parsePatchFiles(details?.patch ?? "")[0]?.lines.find(
        (line) => line.type === "del",
      );
      expect(removed?.content).toBe("const x = 1;  ");
    });

    it("keeps disjoint multi-edits in one original-file transaction", async () => {
      const file = join(tempDir, "multi.ts");
      vol.writeFileSync(file, "const a = 1;\nconst b = 2;\n");
      const edit = await editTool();

      const result = await edit.execute!(
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
      const details = result.details as { patch?: string; parsedDiff?: unknown } | undefined;
      const parsed = parsePatchFiles(details?.patch ?? "")[0];
      expect(parsed?.added).toBe(2);
      expect(details?.parsedDiff).toBeUndefined();
      expect(vol.readFileSync(file, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
    });
  });
});
