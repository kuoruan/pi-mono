import { describe, expect, test } from "vitest";

import { registerTools } from "#test/fixtures.ts";

/**
 * The generic yield: when another extension already owns a tool name, the
 * resolver hands the name back to `next()` (pi's own renderers) instead of
 * painting built-in-shaped renderers over the neighbor's tool. The yield
 * check reads pi's merged registry (name + sourceInfo.source), so the
 * suite stages foreign tools with a non-builtin source.
 *
 * The name is missing from the returned facade because the resolver
 * yielded it (returned the built-in triple by reference); that absence is
 * the observable form of "pi-pigment does not decorate this name".
 */
describe("tool yield on foreign occupancy", () => {
  test("yields a single occupied name and keeps the rest", async () => {
    const tools = await registerTools({}, ["grep"]);
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("grep");
    expect(names).toEqual(expect.arrayContaining(["write", "edit", "bash", "ls", "find"]));
  });

  test("yields every name when all eight are occupied", async () => {
    const tools = await registerTools({}, [
      "write",
      "edit",
      "bash",
      "powershell",
      "grep",
      "ls",
      "find",
      "read",
    ]);
    expect(tools).toEqual([]);
  });

  test("builtin-source entries do not trigger the yield", async () => {
    // No foreignTools staged: the registry only surfaces builtins, so the
    // full eight renderers register — the check keys on the source, not
    // the bare name.
    const tools = await registerTools({});
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"].toSorted(),
    );
  });

  test("yield keys on the source, not the bare name", async () => {
    // The yield condition is `source !== "builtin"`: sdk-passed custom
    // tools share that non-builtin branch with extension-owned ones, and
    // the fixture stages foreign tools with the realistic extension
    // source — so one occupied-name case covers the branch's contract.
    const tools = await registerTools({}, ["ls"]);
    expect(tools.map((tool) => tool.name)).not.toContain("ls");
  });

  test("a re-fire decorates the same names (no self-shadow: the extension registers no tool)", async () => {
    // The extension now registers NO tool, so the only registry entries
    // the yield check sees are foreign names and builtins. A resume/fork
    // re-fire is stable: `claimedByOther` never sees a pi-pigment entry to
    // confuse for a neighbor, and the same eight names come back.
    const first = (await registerTools()).map((tool) => tool.name).toSorted();
    const second = (await registerTools()).map((tool) => tool.name).toSorted();
    expect(first).toHaveLength(8);
    expect(second).toEqual(first);
  });

  test("foreign yield is independent of disabledTools", async () => {
    // The yield layer and the config layer compose without touching:
    // a foreign-owned grep skips at the registry check while every
    // enabled name still registers. (disabledTools itself is covered
    // by tests/config/tool-config.test.ts through staged config files;
    // this suite stages no config, so it cannot exercise that layer.)
    const tools = await registerTools({}, ["grep"]);
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("grep");
    expect(names).toEqual(expect.arrayContaining(["bash", "ls", "find"]));
  });
});
