/**
 * Decision-log reader: the read-only bridge from the permission-review
 * JSONL log (written by this link AND the permission system's terminal
 * decision events, keyed by requestId) to in-process consumers — the
 * `/ai-guard report` candidate signal and the `/ai-guard denied` panel.
 *
 * MODULE INVARIANTS (pinned by test/decision-log-reader.test.ts and the
 * source-scan lint test):
 *
 * - **Never writes**: this module performs zero writes anywhere — no config, no session file, no log
 *   mutation. Reading the log is its entire effect on the world.
 * - **Never auto-applies**: it produces data; every consumer renders suggestions as evidence, and
 *   adopting them is an explicit operator action (copy-paste into the permission config).
 *
 * The log is append-only with no rotation (upstream grows it without
 * limit), so only the tail is read: a fixed line window bounds memory
 * for a file that grows without limit. The window UNDERCOUNTS long
 * histories (conservative — an older occurrence beyond the window is
 * invisible, so groups near the window edge report fewer occurrences
 * than reality).
 */

/**
 * A parsed log line — a loose union of the record shapes this link and
 * the permission system write. Consumers narrow by `event`.
 */
export interface LogEntry {
  /** The event name (`ai_guard.decision`, `permission_request.approved`, …). */
  event: string;
  /** The ask's request id — the join key across record families. */
  requestId?: string;
  /** The decision gate (model, cache-hit, circuit-breaker, …). */
  gate?: string;
  /** The link's verdict (allow / deny / defer). */
  verdict?: string;
  /** The reviewer's lean on a defer. */
  lean?: string | null;
  /** The tool surface. */
  surface?: string;
  /** The value being authorized. */
  target?: string;
  /** The trusted-intent context fingerprint (model gate, later records). */
  contextHash?: string;
  /** The terminal decision's resolution (permission_request.* records). */
  resolution?: string | null;
  /** ISO timestamp (all records carry one). */
  timestamp?: string;
}

/** Read the last `lineCount` lines of a file, or undefined when unreadable. */
export type ReadTailLines = (path: string, lineCount: number) => string[] | undefined;

/** The injected collaborators a log read needs: the tail-read seam. */
export interface LogReadDeps {
  /** Reads a file's trailing lines (production: the fs adapter). */
  readTailLines: ReadTailLines;
}

/** How many trailing lines of the review log the reader consumes. */
export const LOG_TAIL_LINES = 5000;

/**
 * The default review-log path (the permission system's global logs dir).
 *
 * @param home - The user's home directory.
 * @returns The conventional review-log path.
 */
export function reviewLogPath(home: string): string {
  return `${home}/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`;
}

/**
 * Read and parse a JSONL log tail: the format's single owner (tolerant
 * line parse + the record shape). Path-resolving callers use
 * {@link readDecisionLog}; callers with an explicit path (the log-stats
 * script's `--file` override) use this entry directly.
 *
 * @param path - The log file path.
 * @param deps - The tail-read seam (injected; production reads the file).
 * @param lineCount - How many trailing lines to consume (default 5000).
 * @returns The parsed entries in file order, or undefined when the log
 *   cannot be read (missing file → the caller's friendly message).
 */
export function readLogLines(
  path: string,
  deps: LogReadDeps,
  lineCount: number = LOG_TAIL_LINES,
): LogEntry[] | undefined {
  const lines = deps.readTailLines(path, lineCount);
  if (lines === undefined) return undefined;
  const entries: LogEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Corrupt line — skip; the log is append-only and best-effort.
    }
  }
  return entries;
}

/**
 * Read and parse the review log's tail.
 *
 * @param home - The user's home directory (path resolution).
 * @param deps - The tail-read seam (injected; production reads the file).
 * @param lineCount - How many trailing lines to consume (default 5000).
 * @returns The parsed entries in file order, or undefined when the log
 *   cannot be read (missing file → the caller's friendly message).
 */
export function readDecisionLog(
  home: string,
  deps: LogReadDeps,
  lineCount: number = LOG_TAIL_LINES,
): LogEntry[] | undefined {
  return readLogLines(reviewLogPath(home), deps, lineCount);
}
