/**
 * Persistence for session-scoped runtime settings (/ai-guard): setting
 * changes are appended to the pi session file as custom entries (which
 * never enter LLM context) and restored from the active branch on
 * session_start / session_tree.
 *
 * Pure module — no pi handle, no session state. The append function and
 * the branch reader are injected, so persistence semantics (the entry
 * format, "latest statement per setting wins", reset suppression) test
 * directly without extension scaffolding.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The custom-entry type all runtime-setting changes are persisted under.
 * One entry carries one setting's change keyed by setting name; entries
 * for different settings interleave freely on the branch.
 */
export const SETTING_ENTRY_TYPE = "ai-guard-setting";

/**
 * Branch-reader surface the restore scan needs — derived from the host's
 * SessionManager so it can't drift: the scan needs only `getBranch`.
 */
export type SessionBranchReader = Pick<SessionManager, "getBranch">;

/**
 * Append a setting change to the session file. `null` records an explicit
 * reset — on restore it suppresses older persisted values for the same
 * setting (the latest statement stands).
 *
 * @param appendEntry - The pi session-file append function.
 * @param name - The setting name (persistence key).
 * @param value - The new value, or null for an explicit reset.
 */
export function persistSetting(
  appendEntry: (customType: string, data?: unknown) => void,
  name: string,
  value: string | null,
): void {
  appendEntry(SETTING_ENTRY_TYPE, { [name]: value });
}

/**
 * Restore a setting's override from the session file: the most recent
 * ai-guard-setting entry on the ACTIVE branch that carries the setting's
 * key wins (entries on abandoned branches don't count — tree navigation
 * re-derives). Entries for other settings are skipped, not treated as
 * statements about this one. A `null` value (a persisted reset) or an
 * invalid value (a hand-edited session file) restores no override.
 *
 * @param name - The setting name (persistence key).
 * @param validValues - Values restorable from the session file; anything
 *   else persisted is ignored.
 * @param reader - The session manager's branch-reading surface.
 * @returns The persisted override, or undefined for none.
 */
export function restoreSetting(
  name: string,
  validValues: readonly string[],
  reader: SessionBranchReader,
): string | undefined {
  const branch = reader.getBranch(); // root → leaf; the most recent entry is last.
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom" || entry.customType !== SETTING_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data === null || typeof data !== "object") continue;
    if (!(name in data)) continue;
    const value = (data as Record<string, string | null>)[name];
    return typeof value === "string" && validValues.includes(value) ? value : undefined;
  }
  return undefined;
}
