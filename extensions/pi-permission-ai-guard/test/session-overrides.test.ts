/**
 * Session-overrides direct tests: the per-field precedence rule and the
 * save-snapshot projection, pinned at the module's own interface. Every
 * other suite reaches these semantics in translation (through the
 * runtime-settings surface or the pipeline); this file crosses the seam
 * directly so a precedence regression fails here first, by name.
 *
 * The load-bearing invariants under test (from the module docblocks):
 * - override-present means defined (writers delete on undefined);
 * - effectiveConfig skips undefined override keys, so a reset can never
 * shadow the config value into the saved layer file — the bug the
 * projection exists to make impossible;
 * - the snapshot carries every non-override config field untouched.
 */

import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config-schema.ts";
import { effectiveConfig, effectiveOverride } from "#src/session-overrides.ts";

/** A minimal valid config — the schema's own defaults define the base. */
function makeConfig() {
  return configSchema.parse({ provider: "test", model: "test" });
}

describe("effectiveOverride — the per-field rule", () => {
  it("a defined override beats the config value", () => {
    const config = makeConfig();
    expect(effectiveOverride({ mode: "strict" }, config, "mode")).toBe("strict");
    expect(effectiveOverride({ notifyLevel: "off" }, config, "notifyLevel")).toBe("off");
  });

  it("an absent key falls back to the config value", () => {
    const config = configSchema.parse({ provider: "t", model: "m", mode: "lenient" });
    expect(effectiveOverride({}, config, "mode")).toBe("lenient");
    expect(effectiveOverride({ notifyLevel: "error" }, config, "mode")).toBe("lenient");
  });

  it("an undefined override is not a value — the config still wins (undefined-present tolerance)", () => {
    // Writers delete on undefined, but the reader must tolerate the
    // shape that would be written if anyone ever forgot: an explicit
    // undefined must never shadow the config.
    const config = configSchema.parse({ provider: "t", model: "m", mode: "default" });
    expect(effectiveOverride({ mode: undefined }, config, "mode")).toBe("default");
  });

  it("a present config yields a non-optional result; an absent config may yield undefined", () => {
    // notifyLevel is optional in the schema (parsed configs default it to
    // "info"); the undefined-config overload is the path where the field
    // can genuinely be absent — a reader before the config loads.
    const config = makeConfig();
    expect(effectiveOverride({}, config, "notifyLevel")).toBe("info");
    const absent = effectiveOverride({ mode: "permissive" }, undefined, "notifyLevel");
    expect(absent).toBeUndefined();
  });
});

describe("effectiveConfig — the save-snapshot projection", () => {
  it("applies every defined override onto the config", () => {
    const config = makeConfig();
    const effective = effectiveConfig(config, { mode: "strict", notifyLevel: "warning" });
    expect(effective.mode).toBe("strict");
    expect(effective.notifyLevel).toBe("warning");
  });

  it("skips undefined override keys — a reset never shadows the config into the saved layer", () => {
    // The bug this projection exists to make impossible: a stale
    // `mode: undefined` key writing config.mode away as undefined.
    const config = configSchema.parse({ provider: "t", model: "m", mode: "lenient" });
    const effective = effectiveConfig(config, { mode: undefined });
    expect(effective.mode).toBe("lenient");
  });

  it("carries every non-override config field untouched (hole snapshot, not a sparse delta)", () => {
    const config = makeConfig();
    const effective = effectiveConfig(config, { mode: "strict" });
    expect(effective).toEqual({ ...config, mode: "strict" });
  });

  it("an empty override object is the config itself", () => {
    const config = makeConfig();
    expect(effectiveConfig(config, {})).toEqual(config);
  });
});
