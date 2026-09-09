import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";

// Anchored at the package root so the suite runs green from any CWD
// (the monorepo root's `pnpm test` runs all projects from the repo root).
const pkgRoot = join(import.meta.dirname, "../..");

describe("config example & schema", () => {
  it("the shipped example parses through the real zod schema", () => {
    const example = JSON.parse(readFileSync(join(pkgRoot, "config/config.example.json"), "utf-8"));
    const parsed = configSchema.safeParse(example);
    // The example doubles as the defaults showcase: empty disables, bar,
    // and the diff-root override chain (shared + dark variant).
    expect(parsed.success && parsed.data.disabledTools).toEqual([]);
    expect(parsed.success && parsed.data.indicatorStyle).toBe("bar");
  });

  it("the schema's value grammar documents the pair syntax and the AA boundary", () => {
    const schema = JSON.parse(
      readFileSync(join(pkgRoot, "schemas/pi-pigment.schema.json"), "utf-8"),
    );
    const desc: string = schema.properties.syntaxTheme.description;
    // The pi grammar (single name or light/dark pair) and the AA boundary
    // (bundled names enforce, user files verbatim) are the contract the
    // description must keep documenting.
    expect(desc).toContain('"light/dark"');
    expect(desc).toContain("github-light/github-dark");
    expect(desc).toContain("AA-fitted");
  });

  it("the JSON schema's tool enum matches the zod enum", () => {
    const schema = JSON.parse(
      readFileSync(join(pkgRoot, "schemas/pi-pigment.schema.json"), "utf-8"),
    );
    const tools = schema.properties.disabledTools.items.enum;
    expect(tools).toEqual(["write", "edit", "bash", "powershell", "grep", "ls", "find"]);
    // The semantic color keys in $defs match the nine zod keys.
    const keys = Object.keys(schema.$defs.semanticColors.properties);
    expect(keys.toSorted()).toEqual([
      "comment",
      "function",
      "keyword",
      "number",
      "operator",
      "punctuation",
      "string",
      "type",
      "variable",
    ]);
  });
});
