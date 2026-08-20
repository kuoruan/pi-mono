/**
 * Session-settings store direct tests: the persistence entry format and
 * the restore walk ("latest statement per setting wins", reset
 * suppression, invalid-value tolerance) — no extension scaffolding.
 */

import { describe, expect, it, vi } from "vitest";

import {
  SETTING_ENTRY_TYPE,
  type SessionBranchReader,
  persistSetting,
  restoreSetting,
} from "#src/session-settings-store.ts";

/**
 * Build a branch reader over the given entries (root → leaf).
 *
 * @param entries - The active branch's entries.
 * @returns A reader handing back exactly those entries.
 */
function readerOf(entries: unknown[]): SessionBranchReader {
  return { getBranch: () => entries as never[] };
}

/**
 * Build a custom ai-guard-setting entry.
 *
 * @param data - The persisted setting data (keyed by setting name).
 * @returns A minimal custom-entry object shaped like a persisted entry.
 */
function settingEntry(data: Record<string, string | null>): unknown {
  return { type: "custom", customType: SETTING_ENTRY_TYPE, data };
}

const POLICY_VALUES = ["manual", "default", "auto"];

describe("persistSetting", () => {
  it("appends the setting's change under the ai-guard-setting entry type", () => {
    const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
    persistSetting(appendEntry, "mode", "manual");
    expect(appendEntry).toHaveBeenCalledWith(SETTING_ENTRY_TYPE, { mode: "manual" });
  });

  it("persists an explicit reset as null", () => {
    const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
    persistSetting(appendEntry, "mode", null);
    expect(appendEntry).toHaveBeenCalledWith(SETTING_ENTRY_TYPE, { mode: null });
  });
});

describe("restoreSetting", () => {
  it("restores from the most recent entry carrying the setting", () => {
    const reader = readerOf([settingEntry({ mode: "manual" })]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBe("manual");
  });

  it("the latest statement wins over older entries", () => {
    const reader = readerOf([settingEntry({ mode: "manual" }), settingEntry({ mode: "auto" })]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBe("auto");
  });

  it("a persisted reset suppresses an older override on the same path", () => {
    const reader = readerOf([settingEntry({ mode: "manual" }), settingEntry({ mode: null })]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBeUndefined();
  });

  it("an invalid persisted value is ignored (hand-edited session file)", () => {
    const reader = readerOf([settingEntry({ mode: "yolo" })]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBeUndefined();
  });

  it("walks past non-setting entries to the newest setting entry", () => {
    // Root→leaf: the setting sits below a newer plain message entry.
    const reader = readerOf([
      settingEntry({ mode: "manual" }),
      { type: "message", parentId: "e1", id: "e2" },
    ]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBe("manual");
  });

  it("skips entries about other settings — they are not statements about this one", () => {
    // A second setting's entries must not erase this setting's override:
    // the newest entry CARRYING the key wins, not the newest entry.
    const reader = readerOf([
      settingEntry({ mode: "manual" }),
      settingEntry({ surfaces: "bash-only" }),
    ]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBe("manual");
  });

  it("a newer reset still suppresses an older value with other entries between", () => {
    const reader = readerOf([
      settingEntry({ mode: "manual" }),
      settingEntry({ surfaces: "bash-only" }),
      settingEntry({ mode: null }),
    ]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBeUndefined();
  });

  it("returns undefined with no setting entries on the branch", () => {
    expect(restoreSetting("mode", POLICY_VALUES, readerOf([]))).toBeUndefined();
  });

  it("tolerates malformed entries (null or non-object data)", () => {
    const reader = readerOf([
      { type: "custom", customType: SETTING_ENTRY_TYPE, data: null },
      { type: "custom", customType: SETTING_ENTRY_TYPE },
      settingEntry({ mode: "auto" }),
    ]);
    expect(restoreSetting("mode", POLICY_VALUES, reader)).toBe("auto");
  });
});
