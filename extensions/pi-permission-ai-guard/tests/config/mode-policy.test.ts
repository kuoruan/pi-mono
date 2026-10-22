/**
 * Resolver tests: the configured mode becomes the policy the pipeline runs.
 * Built-in rungs read the table; `custom` reads the config's cut lines, and
 * an unusable `custom` repairs to `default` with a finding instead of
 * failing the load.
 */

import { describe, expect, it } from "vitest";

import type { ModeConfig } from "#src/config/mode-policy.ts";
import {
  cycleValues,
  isHighlighted,
  resolveModePolicy,
  selectableModes,
} from "#src/config/mode-policy.ts";

const ASK_FREE_CUSTOM: ModeConfig = {
  mode: "custom",
  customMode: {
    allowThrough: "defer-neutral",
    denyFrom: "defer-danger",
    onReviewFailure: "deny",
    onIrreversibleEffect: "defer",
  },
};

/** A config with no custom row: the resting state every default surface reads. */
const NO_CUSTOM: ModeConfig = { mode: "default", customMode: null };

const ASKING_CUSTOM: ModeConfig = {
  mode: "custom",
  customMode: {
    allowThrough: "defer-benign",
    denyFrom: "hard-deny",
    onReviewFailure: "defer",
    onIrreversibleEffect: "defer",
  },
};

describe("resolveModePolicy", () => {
  it("reads a built-in rung straight from the table", () => {
    const { policy, fallbackTo, issues } = resolveModePolicy({ mode: "auto", customMode: null });
    expect(policy).toEqual({
      mode: "auto",
      cuts: { allowThrough: "defer-neutral", denyFrom: "defer-danger" },
      onReviewFailure: "deny",
      // Built-in rungs always confirm a proven-irreversible effect.
      onIrreversibleEffect: "defer",
    });
    expect(fallbackTo).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it("warns about a customMode block the selected mode never reads", () => {
    const { policy, fallbackTo, issues } = resolveModePolicy({
      mode: "default",
      customMode: ASK_FREE_CUSTOM.customMode,
    });
    expect(policy.mode).toBe("default");
    expect(fallbackTo).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("customMode");
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain('mode is "default"');
  });

  it("repairs mode custom with no block to default and says so at error level", () => {
    const { policy, fallbackTo, issues } = resolveModePolicy({ mode: "custom", customMode: null });
    expect(policy.mode).toBe("default");
    expect(policy.cuts).toEqual({ allowThrough: "allow", denyFrom: "hard-deny" });
    expect(fallbackTo).toBe("default");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("mode");
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toContain('running "default" instead');
  });

  it("runs a custom pair's own cuts and failure lane", () => {
    const { policy, fallbackTo, issues } = resolveModePolicy(ASKING_CUSTOM);
    expect(policy).toEqual({
      mode: "custom",
      cuts: { allowThrough: "defer-benign", denyFrom: "hard-deny" },
      onReviewFailure: "defer",
      onIrreversibleEffect: "defer",
    });
    expect(fallbackTo).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it("warns when a custom pair redraws a built-in rung exactly", () => {
    const { policy, issues } = resolveModePolicy(ASK_FREE_CUSTOM);
    expect(policy.mode).toBe("custom");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain('"auto"');
  });

  it("carries the custom irreversible ruling, including allow", () => {
    const { policy, issues } = resolveModePolicy({
      mode: "custom",
      customMode: { ...ASKING_CUSTOM.customMode!, onIrreversibleEffect: "allow" as const },
    });
    expect(policy.onIrreversibleEffect).toBe("allow");
    expect(issues).toEqual([]);
  });

  it("does not call a custom row redundant when only the irreversible axis differs", () => {
    // Same cuts and failure lane as auto, but the floor ruling differs — the
    // row is not that rung, so no "use auto instead" warning.
    const { issues } = resolveModePolicy({
      mode: "custom",
      customMode: { ...ASK_FREE_CUSTOM.customMode!, onIrreversibleEffect: "allow" as const },
    });
    expect(issues).toEqual([]);
  });
});

describe("cycleValues", () => {
  it("is the built-in casual subset with no custom configured", () => {
    expect(cycleValues(NO_CUSTOM)).toEqual(["default", "auto"]);
  });

  it("appends a configured custom last, never first", () => {
    expect(cycleValues(ASK_FREE_CUSTOM)).toEqual(["default", "auto", "custom"]);
  });
});

describe("isHighlighted", () => {
  it("marks the cycled ask-free rung and nothing else", () => {
    const plain = { mode: "default", customMode: null } as const;
    for (const mode of ["strict", "default", "auto"] as const) {
      const { policy } = resolveModePolicy({ ...plain, mode });
      expect(isHighlighted(policy, plain)).toBe(mode === "auto");
    }
  });

  it("marks an ask-free custom the cycle can reach", () => {
    const { policy } = resolveModePolicy(ASK_FREE_CUSTOM);
    expect(isHighlighted(policy, ASK_FREE_CUSTOM)).toBe(true);
  });

  it("leaves an asking custom plain", () => {
    const { policy } = resolveModePolicy(ASKING_CUSTOM);
    expect(isHighlighted(policy, ASKING_CUSTOM)).toBe(false);
  });

  it("never marks the fallback of an unconfigured custom", () => {
    const { policy } = resolveModePolicy({ mode: "custom", customMode: null });
    expect(isHighlighted(policy, { mode: "custom", customMode: null })).toBe(false);
  });
});

describe("selectableModes", () => {
  it("hides custom while no block configures it", () => {
    expect(selectableModes(NO_CUSTOM)).toEqual(["strict", "default", "auto"]);
  });

  it("offers custom once the block is present", () => {
    expect(selectableModes(ASK_FREE_CUSTOM)).toEqual(["strict", "default", "auto", "custom"]);
  });
});
