/**
 * Log statistics: read-only analysis of the permission-review JSONL log —
 * the data gate for the lean-binarization decision and the occurrence-
 * threshold calibration for the /ai-guard report candidate signal.
 *
 * Outputs three tables:
 *
 * 1. Model-defer distribution — total model-gate defers, lean split, and the neutral share (the
 *    binarization trigger: <5% neutral → lean binarization is worth considering).
 * 2. Repeated-review histogram — model-gate records grouped by (surface, target), counted ONLY at the
 *    model gate (pre-call machinery failures never reach the model and carry no review evidence),
 *    bucketed 2/3/4/5+.
 * 3. Outcome distribution per repeated group — how the terminal permission decisions resolved
 *    (approved / session_approved / auto_approved / blocked / denied / …), linked by requestId.
 *
 * @example
 *   npx tsx scripts/log-stats.ts
 *   npx tsx scripts/log-stats.ts --file /path/to/review.jsonl
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface LogRecord {
  event?: string;
  requestId?: string;
  gate?: string;
  verdict?: string;
  lean?: string | null;
  surface?: string;
  target?: string;
  resolution?: string | null;
}

const DEFAULT_LOG = join(
  homedir(),
  ".pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl",
);

function readRecords(path: string): LogRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`cannot read ${path} — pass --file /path/to/review.jsonl`);
    process.exit(1);
  }
  const records: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as LogRecord);
    } catch {
      // Corrupt line — skip (the log is append-only and best-effort).
    }
  }
  return records;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      file: { type: "string", default: DEFAULT_LOG },
    },
  });
  const records = readRecords(values.file ?? DEFAULT_LOG);

  // ── 1. Model-defer lean distribution ──
  const modelGates = records.filter((r) => r.event === "ai_guard.decision" && r.gate === "model");
  const defers = modelGates.filter((r) => r.verdict === "defer");
  const leanCount = new Map<string, number>();
  for (const d of defers) {
    const key = d.lean ?? "absent";
    leanCount.set(key, (leanCount.get(key) ?? 0) + 1);
  }
  const neutral = (leanCount.get("absent") ?? 0) + 0; // absent = genuinely neutral
  const neutralShare = defers.length > 0 ? (neutral / defers.length) * 100 : 0;
  console.log("── model defers (lean distribution) ──");
  console.log(`model gates: ${modelGates.length}, defers: ${defers.length}`);
  for (const [k, v] of leanCount) console.log(`  lean ${k}: ${v}`);
  console.log(`  neutral share: ${neutralShare.toFixed(1)}% (binarization trigger: <5%)`);
  console.log();

  // ── 2. Repeated-review histogram (model gate only) ──
  const groups = new Map<string, number>();
  for (const r of modelGates) {
    const key = `${r.surface ?? "?"}\t${r.target ?? "?"}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const buckets = { "2": 0, "3": 0, "4": 0, "5+": 0 } as Record<string, number>;
  const repeated: Array<{ key: string; n: number }> = [];
  for (const [key, n] of groups) {
    if (n < 2) continue;
    repeated.push({ key, n });
    if (n >= 5) buckets["5+"]++;
    else buckets[String(n)]++;
  }
  repeated.sort((a, b) => b.n - a.n);
  console.log("── repeated (surface, target) groups at the model gate ──");
  console.log(
    `2×: ${buckets["2"]}  3×: ${buckets["3"]}  4×: ${buckets["4"]}  5+: ${buckets["5+"]}`,
  );
  console.log("top 10:");
  for (const g of repeated.slice(0, 10)) console.log(`  ${g.n}× ${g.key.replace("\t", " ")}`);
  console.log();

  // ── 3. Outcome distribution per repeated group (requestId-linked) ──
  const terminal = new Map<string, string>();
  for (const r of records) {
    const ev = r.event ?? "";
    if (!ev.startsWith("permission_request.")) continue;
    if (ev === "permission_request.waiting") continue; // non-terminal
    const rid = r.requestId;
    if (rid) terminal.set(rid, ev.replace("permission_request.", ""));
  }
  const outcomes = new Map<string, number>();
  for (const r of modelGates) {
    const outcome = terminal.get(r.requestId ?? "");
    if (outcome) outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }
  console.log("── terminal outcomes of model-gate asks (all, requestId-linked) ──");
  for (const [k, v] of [...outcomes.entries()].toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
}

main();
