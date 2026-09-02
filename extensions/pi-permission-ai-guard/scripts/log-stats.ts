/**
 * Log statistics: read-only analysis of the permission-review JSONL log —
 * the data gate for the lean-binarization decision and the occurrence-
 * threshold calibration for the /ai-guard report candidate signal.
 *
 * The log format (record shape, tolerant parse, canonical path, tail
 * bound) is owned by the decision-log-reader module — this script only
 * aggregates. Every field it consumes breaks this script at compile time
 * when the shape changes (the pre-refactor copy here silently missed
 * `contextHash` — a drift that now surfaces as a compile error for every
 * consumed field).
 *
 * Outputs three tables:
 *
 * 1. Model-defer distribution — total model-gate defers, lean split, and the neutral share (the
 *    binarization trigger: <5% neutral → lean binarization is worth considering).
 * 2. Repeated-review histogram — model-gate records grouped by (surface, target), counted ONLY at the
 *    model gate (pre-call machinery failures never reach the model and carry no review evidence),
 *    bucketed 2/3/4/5+. Alongside: how many repeated groups are ALSO single-context (every
 *    occurrence carries the same contextHash, no legacy records) — the report signal's actual
 *    grouping, which is stricter than the raw (surface, target) count.
 * 3. Outcome distribution per repeated group — how the terminal permission decisions resolved
 *    (approved / session_approved / auto_approved / blocked / denied / …), linked by requestId.
 *
 * @example
 *   npx tsx scripts/log-stats.ts
 *   npx tsx scripts/log-stats.ts --file /path/to/review.jsonl
 */

import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { readLogLines, reviewLogPath } from "#src/audit/decision-log-reader.ts";
import { readTailLinesFromFile } from "#src/audit/log-tail-fs.ts";

/** A repeated-ask group's running aggregate at the model gate. */
interface GroupAggregate {
  /** Total model-gate records in the (surface, target) group. */
  n: number;
  /** The distinct trusted-intent fingerprints seen (undefined = legacy record, unprovable). */
  hashes: Set<string>;
  /** True when any record predates the contextHash field. */
  legacy: boolean;
}

/** A repeated group, ranked for the top-10 listing. */
interface RepeatedGroup {
  /** The group key (`surface\ttarget`). */
  key: string;
  /** Total model-gate reviews. */
  n: number;
  /** The report signal's grouping: no legacy records, one contextHash. */
  singleContext: boolean;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      file: { type: "string", default: reviewLogPath(homedir()) },
    },
  });
  const path = values.file ?? reviewLogPath(homedir());
  const records = readLogLines(path, { readTailLines: readTailLinesFromFile });
  if (records === undefined) {
    console.error(`cannot read ${path} — pass --file /path/to/review.jsonl`);
    process.exit(1);
  }

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
  const groups = new Map<string, GroupAggregate>();
  for (const r of modelGates) {
    const key = `${r.surface ?? "?"}\t${r.target ?? "?"}`;
    const g = groups.get(key) ?? { n: 0, hashes: new Set<string>(), legacy: false };
    g.n += 1;
    // A record with no contextHash (pre-0.9.0 legacy) can never prove
    // same-context — mirror the report signal's conservative exclusion.
    if (r.contextHash !== undefined) g.hashes.add(r.contextHash);
    else g.legacy = true;
    groups.set(key, g);
  }
  const buckets = { "2": 0, "3": 0, "4": 0, "5+": 0 } as Record<string, number>;
  const repeated: RepeatedGroup[] = [];
  let singleContextGroups = 0;
  for (const [key, g] of groups) {
    if (g.n < 2) continue;
    // Single-context = the report signal's grouping: no legacy records,
    // and every occurrence carries the same contextHash.
    const singleContext = !g.legacy && g.hashes.size === 1;
    if (singleContext) singleContextGroups++;
    repeated.push({ key, n: g.n, singleContext });
    if (g.n >= 5) buckets["5+"]++;
    else buckets[String(g.n)]++;
  }
  repeated.sort((a, b) => b.n - a.n);
  console.log("── repeated (surface, target) groups at the model gate ──");
  console.log(
    `2×: ${buckets["2"]}  3×: ${buckets["3"]}  4×: ${buckets["4"]}  5+: ${buckets["5+"]}`,
  );
  console.log(
    `single-context groups (the report signal's grouping): ${singleContextGroups}/${repeated.length}`,
  );
  console.log("top 10:");
  for (const g of repeated.slice(0, 10)) {
    console.log(
      `  ${g.n}× ${g.key.replace("\t", " ")}${g.singleContext ? "  [single-context]" : ""}`,
    );
  }
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
