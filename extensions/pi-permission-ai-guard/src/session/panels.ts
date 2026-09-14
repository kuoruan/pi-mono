/**
 * The read-only audit panels: `/ai-guard report` (repeated same-context
 * asks, with copy-paste rule fragments) and `/ai-guard denied` (this
 * session's model-gate denies). Both are browse surfaces over data the
 * settings surface does not own — the permission-review log's tail and the
 * session's deny history — so they live beside it rather than inside it:
 * the list rides the host's standard `ui.select` (the shared
 * {@link pickItem}), and a picked entry opens the detail dialog.
 *
 * Nothing here applies policy: both panels are evidence for the operator.
 */

import type { LogEntry } from "#src/audit/decision-log-reader.ts";
import { buildReportCandidates } from "#src/audit/report.ts";
import type { DenyRecord, NotifyFn } from "#src/review/review-pipeline.ts";

import { type RecordDetail, showRecordDetail } from "./record-detail.ts";
import type { AiGuardUiContext } from "./runtime-settings.ts";

/**
 * What the panels read. Kept apart from
 * {@link RuntimeSettingsDeps} so the settings seam carries no report facts
 * (panel feedback rides the shared `notify` seam) — `readDenyHistory` is a
 * reader rather than an array because the live array is recreated at each
 * session_start, after this object is wired once.
 */
export interface PanelReaders {
  /**
   * Reads the permission-review log's tail for the report command —
   * injected (production reads the real file; tests inject fixtures).
   * Returns undefined when the log cannot be read.
   */
  readDecisionLog: () => LogEntry[] | undefined;
  /** This session's model-gate deny history (empty when no session). */
  readDenyHistory: () => readonly DenyRecord[];
}

/** What a panel open function takes: the reads plus the feedback seam. */
export interface PanelDeps extends PanelReaders {
  /** Command feedback — the session's notify seam, never level-gated. */
  notify: NotifyFn;
}

/**
 * Pick one item from a labeled list on the host's standard picker. The
 * labels are the selection channel (the host returns the label), so
 * resolution is an index into the same list — the shape both the panels
 * and the settings pickers use.
 *
 * @param ctx - The command UI context (needs a picker-capable UI).
 * @param title - The picker title.
 * @param items - The items to choose from.
 * @param render - The item's list label.
 * @returns The picked item, or undefined when cancelled.
 */
export async function pickItem<T>(
  ctx: AiGuardUiContext,
  title: string,
  items: readonly T[],
  render: (item: T) => string,
): Promise<T | undefined> {
  const labels = items.map(render);
  const choice = await ctx.ui.select(title, labels);
  return choice === undefined ? undefined : items[labels.indexOf(choice)];
}

/**
 * The report panel: aggregate the review log's repeated same-context asks
 * and offer copy-paste permission-rule fragments — evidence for the
 * operator, never an applied rule. Reads the log tail read-only.
 *
 * @param deps - The panel's reads and feedback seam.
 * @param ctx - The command context (notify + optional picker).
 */
export async function openReportPanel(deps: PanelDeps, ctx: AiGuardUiContext): Promise<void> {
  const entries = deps.readDecisionLog();
  if (entries === undefined) {
    deps.notify("no review log found — nothing to report yet", "info");
    return;
  }
  const candidates = buildReportCandidates(entries);
  if (candidates.length === 0) {
    deps.notify("no repeated same-context asks found in the recent review log", "info");
    return;
  }
  // Summary lines first (feedback channel — a direct answer to the typed
  // command, never level-gated), then the standard list, then the overlay
  // detail for the picked suggestion.
  const top = candidates.slice(0, 10);
  for (const c of top.slice(0, 5)) {
    deps.notify(`${c.occurrences}× ${c.target} (${c.surface})`, "info");
  }
  if (!ctx.hasUI) {
    deps.notify("pass a picker-capable UI to browse the suggested rule fragments", "info");
    return;
  }
  const picked = await pickItem(
    ctx,
    "ai-guard report — pick a suggestion to view its rule",
    top,
    (c) => `${c.occurrences}× ${c.target} (${c.surface})`,
  );
  if (!picked) return;
  const detail: RecordDetail = {
    title: `suggested rule · ${picked.occurrences}× · ${picked.surface}`,
    command: picked.target,
    body: [
      {
        kind: "text",
        text: "reviewed 3+ times in one context with no terminal deny — confirm, then paste into pi-permission-system config",
        tone: "muted",
      },
      { kind: "emphasis", text: picked.suggestedRule },
    ],
  };
  await showRecordDetail(ctx.ui.custom, detail);
}

/**
 * The denied panel: this session's model-gate denies, most recent first —
 * what the reviewer itself refused. Read-only memory, no log dependency
 * (the panel is session-scoped by construction).
 *
 * @param deps - The panel's reads and feedback seam.
 * @param ctx - The command context (notify + optional picker).
 */
export async function openDeniedPanel(deps: PanelDeps, ctx: AiGuardUiContext): Promise<void> {
  const history = deps.readDenyHistory();
  if (history.length === 0) {
    deps.notify("no model-gate denies in this session", "info");
    return;
  }
  if (!ctx.hasUI) {
    deps.notify(`pass a picker-capable UI to browse the ${history.length} deny record(s)`, "info");
    return;
  }
  const recent = history.toReversed();
  // The list line is a scan index (metadata + truncated command, the pick
  // seam's uniqueness discipline); the overlay detail is the reading
  // surface — the command and the reason whole, no notify ceiling (the old
  // single-line echo truncated at 200).
  const record = await pickItem(
    ctx,
    "ai-guard denied — pick a record to view its reason",
    recent,
    (d) =>
      `deny${d.riskLevel ? ` (${d.riskLevel})` : ""} — ${d.target} [${d.surface}] (${d.timestamp.slice(11, 23)})`,
  );
  if (!record) return;
  const detail: RecordDetail = {
    title: `model deny · ${record.timestamp}`,
    command: record.target,
    body: [
      ...(record.reason
        ? [{ kind: "text" as const, text: record.reason, tone: "text" as const }]
        : [{ kind: "text" as const, text: "no reason recorded", tone: "muted" as const }]),
      ...(record.riskLevel
        ? [{ kind: "field" as const, label: "risk level", value: record.riskLevel }]
        : []),
      { kind: "field" as const, label: "request id", value: record.requestId },
    ],
  };
  await showRecordDetail(ctx.ui.custom, detail);
}
