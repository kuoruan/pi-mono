import type * as FsModule from "node:fs";
import { join } from "node:path";

import { vol } from "memfs";
import { describe, expect, it, vi } from "vitest";

// The golden schema file is real (a committed asset): copy it into the
// volume (read through the ACTUAL fs) so the whole file runs under one fs.
vi.mock("node:fs", async () => {
  const actual = (await vi.importActual("node:fs")) as typeof FsModule;
  vol.fromJSON({
    // The real read is anchored at the package root (import.meta is not
    // a hoisted binding) so the factory finds the asset from any CWD; the
    // volume key stays relative — memfs resolves it against the same cwd
    // the mocked readFileSync below uses, so they always match.
    "schemas/pi-pigment.schema.json": actual.readFileSync(
      join(import.meta.dirname, "../../schemas/pi-pigment.schema.json"),
      "utf-8",
    ),
  });
  return (await import("memfs")).fs;
});

import { readFileSync } from "node:fs";

import { loadPigmentConfig } from "#src/config/config-layer.ts";
import { writeFile } from "#test/memfs.ts";

describe("the $schema editor-association key", () => {
  it("is ignored at load — the layer's real keys still apply", () => {
    const root = "/project";
    const layerDir = join(root, ".pi", "extensions", "pigment");
    writeFile(join(layerDir, "config.jsonc"), {
      $schema:
        "https://raw.githubusercontent.com/kuoruan/pi-mono/master/extensions/pi-pigment/schemas/pi-pigment.schema.json",
      indicatorStyle: "none",
      disabledTools: ["bash"],
    });
    const { config, issues } = loadPigmentConfig({ cwd: root, agentDir: join(root, "agent") });
    // The association key must not reject the layer: the other keys land.
    expect(issues).toEqual([]);
    expect(config.indicatorStyle).toBe("none");
    expect(config.disabledTools).toEqual(["bash"]);
  });

  it("is accepted by the JSON schema the README points editors at", () => {
    const schema = JSON.parse(readFileSync("schemas/pi-pigment.schema.json", "utf-8"));
    expect(Object.hasOwn(schema.properties, "$schema")).toBe(true);
  });
});
