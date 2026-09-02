/**
 * The production fs adapter for the decision-log reader's tail-read seam
 * (`ReadTailLines` in decision-log-reader.ts). The reader stays pure — its
 * file access is injected; this module IS the injection.
 *
 * MODULE INVARIANT: read-only — never writes, never creates, never deletes
 * (pinned by the source-scan test in tests/audit/module-invariants.test.ts).
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Read the last `lineCount` lines of a UTF-8 file, or undefined when
 * unreadable (missing file, permission) — the only file access the report
 * command and the log-stats script perform. Tail-bounded in BOTH the
 * parse window and memory: only the final chunk of the file is read (the
 * log grows without rotation, so a whole-file read would grow with it).
 * The chunk assumes ~1KB per line — when a pathological long line exceeds
 * the chunk, the window silently shrinks (conservative: fewer entries,
 * never wrong ones).
 *
 * @param path - The file path.
 * @param lineCount - How many trailing lines to return.
 * @returns The trailing lines, or undefined when the file cannot be read.
 */
export function readTailLinesFromFile(path: string, lineCount: number): string[] | undefined {
  try {
    const { size } = statSync(path);
    // A generous per-line allowance: 1KB × the window. When the whole file
    // is smaller, read it all (the bound holds trivially).
    const chunkBytes = Math.min(size, lineCount * 1024);
    const start = size - chunkBytes;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(chunkBytes);
      readSync(fd, buffer, 0, chunkBytes, start);
      const lines = buffer.toString("utf8").split("\n");
      // A trailing newline yields one phantom empty element after split;
      // drop it so the window counts real lines (otherwise the last live
      // record would be evicted by a ghost — parse-side guards make the
      // empty line harmless, but the window budget is physical).
      const real = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
      // The first line is usually mid-line (the chunk starts at a byte
      // offset); drop it unless the read starts at the file's beginning.
      const usable = start > 0 ? real.slice(1) : real;
      return usable.slice(-lineCount);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
