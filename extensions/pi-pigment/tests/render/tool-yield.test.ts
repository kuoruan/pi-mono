import { describe, expect, test } from "vitest";

import { registerTools } from "#test/fixtures.ts";

/**
 * The generic yield: when another extension already owns a tool name, the
 * extension skips its wrapper instead of shadowing the neighbor. The
 * occupancy check reads pi's merged registry (name + sourceInfo.source),
 * so the suite stages foreign tools with a non-builtin source and the
 * facade's own re-registrations with the realistic local source.
 */
describe("tool yield on foreign occupancy", () => {
  test("yields a single occupied name and keeps the rest", async () => {
    const tools = await registerTools({}, ["grep"]);
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("grep");
    expect(names).toEqual(expect.arrayContaining(["write", "edit", "bash", "ls", "find"]));
  });

  test("yields every name when all seven are occupied", async () => {
    const tools = await registerTools({}, [
      "write",
      "edit",
      "bash",
      "powershell",
      "grep",
      "ls",
      "find",
    ]);
    expect(tools).toEqual([]);
  });

  test("builtin-source entries do not trigger the yield", async () => {
    // No foreignTools staged: the registry only surfaces builtins, so the
    // full seven wrappers register — the check keys on the source, not
    // the bare name.
    const tools = await registerTools({});
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "powershell", "write"].toSorted(),
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

  test("resume re-fire does not yield to our own registration (self-shadowing guard)", async () => {
    // The shared registry models pi's persistent one: the first fire's
    // local-sourced wrappers stay visible, so a second fire served from
    // the same registry must still register all seven — the guard
    // excludes our own prior names, and only genuinely foreign names
    // yield. Without the shared array the mock re-created an empty
    // registry per call and the guard never fired.
    const shared: Awaited<ReturnType<typeof registerTools>> = [];
    const first = await registerTools({}, [], shared);
    expect(first).toHaveLength(7);
    const second = await registerTools({}, [], shared);
    expect(second.map((tool) => tool.name).toSorted()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "powershell", "write"].toSorted(),
    );
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
