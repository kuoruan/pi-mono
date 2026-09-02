/**
 * Report candidates: the aggregation behind `/ai-guard report` — which
 * repeatedly-reviewed asks deserve a deterministic permission rule, so
 * the model stops re-reviewing what the operator keeps allowing.
 *
 * MODULE INVARIANTS (pinned by source-scan lint tests):
 *
 * - **Never writes**: zero write paths — no config, no session file, no log mutation. Producing
 *   evidence is this module's entire effect.
 * - **Never auto-applies**: suggestions render as copy-paste fragments; adopting one is an explicit
 *   operator action.
 * - **Suggestions are evidence, not authorization**: a candidate says "this was reviewed N times in
 *   one context and the operator let it pass each time" — nothing here authorizes anything by
 *   itself.
 *
 * Candidate signal (ALL must hold) — the difference between routine and
 * noise:
 *
 * 1. The same (surface, target) reached the MODEL gate ≥ minOccurrences times (pre-call machinery
 *    failures never produce review evidence and carry no contextHash — only model-gate records
 *    count).
 * 2. Every occurrence shares the SAME contextHash (one trusted-intent context — the operator was
 *    running one routine, not re-judging the command across different tasks). Records without a
 *    contextHash (written before the field existed) fail this check — the whole group is excluded,
 *    conservatively.
 * 3. No occurrence ended in a terminal deny (blocked/denied) — an operator refusal anywhere
 *    disqualifies the group.
 */

import type { LogEntry } from "./decision-log-reader.ts";

/**
 * A report candidate: one (surface, target) group that passed the
 * signal, with the suggested permission-rule fragment.
 */
export interface ReportCandidate {
  /** The tool surface (bash, mcp, …). */
  surface: string;
  /** The reviewed value (command, tool name, …). */
  target: string;
  /** How many model-gate reviews the group contains. */
  occurrences: number;
  /** The suggested permission-config fragment (copy-paste ready). */
  suggestedRule: string;
}

/**
 * The default occurrence threshold — calibrated from live data: 2×
 * groups are dominated by one-off re-runs; 3×+ separates routine
 * repetition (16× at 2, 20 groups at 3+ in the reference log).
 */
export const DEFAULT_MIN_OCCURRENCES = 3;

/**
 * A bash word that can appear in a templated rule: ASCII letters,
 * digits, and safe punctuation, ≤64 chars — no shell metacharacters,
 * no spaces, no quoting. Derived from this threat model (a longer word
 * or any metacharacter means the template would not match the exact
 * command, so the original text is used verbatim instead).
 */
const SAFE_BASH_WORD = /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,63}$/;

/**
 * Template a bash target into a rule pattern, or return it verbatim
 * when any word is unsafe (variables, pipes, redirections, paths, or
 * anything the template could not reproduce exactly).
 *
 * @param target - The bash command string.
 * @returns The templated pattern (e.g. `git status --short`) or the
 *   original target when templating is not provably safe.
 */
export function templateBashTarget(target: string): string {
  const words = target.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return target;
  return words.every((w) => SAFE_BASH_WORD.test(w)) ? words.join(" ") : target;
}

/**
 * Build the report candidates from parsed log entries.
 *
 * @param entries - The parsed review-log entries (file order).
 * @param minOccurrences - The repetition threshold (default 3).
 * @returns The candidates, most-reviewed first.
 */
export function buildReportCandidates(
  entries: LogEntry[],
  minOccurrences: number = DEFAULT_MIN_OCCURRENCES,
): ReportCandidate[] {
  // Model-gate records only — the review evidence lives there. A model
  // deny is also terminal for its group (the reviewer refused — the
  // signal's own "the operator let it pass" semantics, held here rather
  // than trusted from upstream's terminal-deny records).
  const modelGates = entries.filter(
    (e) => e.event === "ai_guard.decision" && e.gate === "model" && e.verdict !== "deny",
  );

  // Terminal denies by requestId — an operator refusal disqualifies the group.
  const deniedRequestIds = new Set(
    entries
      .filter(
        (e) => e.event === "permission_request.blocked" || e.event === "permission_request.denied",
      )
      .map((e) => e.requestId)
      .filter((id): id is string => id !== undefined),
  );

  // Group model-gate records by (surface, target).
  const groups = new Map<string, LogEntry[]>();
  for (const e of modelGates) {
    const key = `${e.surface ?? "?"}\u0000${e.target ?? "?"}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const candidates: ReportCandidate[] = [];
  for (const [key, records] of groups) {
    if (records.length < minOccurrences) continue;
    // Same-context requirement: every occurrence carries the same
    // contextHash, and none may be missing (legacy records — written
    // before the field existed — exclude the whole group).
    const hashes = new Set(records.map((r) => r.contextHash));
    if (hashes.size !== 1) continue;
    if (records.some((r) => r.contextHash === undefined)) continue;
    // No terminal deny in the group.
    if (records.some((r) => r.requestId && deniedRequestIds.has(r.requestId))) continue;

    const [surface, target] = key.split("\u0000");
    const pattern = surface === "bash" ? templateBashTarget(target ?? "") : (target ?? "");
    candidates.push({
      surface: surface ?? "?",
      target: target ?? "?",
      occurrences: records.length,
      suggestedRule: JSON.stringify({ [surface ?? "?"]: { [pattern]: "allow" } }),
    });
  }

  return candidates.toSorted((a, b) => b.occurrences - a.occurrences);
}
