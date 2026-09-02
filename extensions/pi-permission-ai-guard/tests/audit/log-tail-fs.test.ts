/**
 * Log-tail-fs direct tests: the production tail adapter's windowing and
 * error contract, over real temp files — the one seam where the 5000-line
 * bound is physically enforced (the reader's injected seam is tested in
 * decision-log-reader.test.ts; this pins the adapter's half).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTailLinesFromFile } from "#src/audit/log-tail-fs.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A temp file with `n` numbered lines (line i reads `line-i`), JSONL-
 * shaped with a trailing newline (the production log's form).
 *
 * @param n - How many lines to write.
 * @returns The temp file's path.
 */
function numberedLog(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-guard-tail-"));
  dirs.push(dir);
  const path = join(dir, "review.jsonl");
  writeFileSync(path, `${Array.from({ length: n }, (_, i) => `line-${i}`).join("\n")}\n`, "utf8");
  return path;
}

describe("readTailLinesFromFile", () => {
  it("returns the trailing lines of a file shorter than the window", () => {
    expect(readTailLinesFromFile(numberedLog(3), 5000)).toEqual(["line-0", "line-1", "line-2"]);
  });

  it("reads only the LAST window lines when the log exceeds it (the 5000-line bound is physical)", () => {
    const n = 6000;
    const lines = readTailLinesFromFile(numberedLog(n), 5000);
    expect(lines).toHaveLength(5000);
    // The first surviving line is the newest one inside the window.
    expect(lines?.[0]).toBe("line-1000");
    expect(lines?.at(-1)).toBe(`line-${n - 1}`);
  });

  it("returns undefined for a missing file (the caller's friendly message)", () => {
    expect(readTailLinesFromFile(join(tmpdir(), "ai-guard-no-such-log.jsonl"), 5000)).toBe(
      undefined,
    );
  });

  it("drops the leading partial line when the chunk starts mid-line", () => {
    // A chunk-sized read starts at a byte offset: the first fragment is
    // usually a mid-line cut, and the adapter must not return it as a
    // whole line. Force the cut with one long first line.
    const dir = mkdtempSync(join(tmpdir(), "ai-guard-tail-"));
    dirs.push(dir);
    const path = join(dir, "review.jsonl");
    const filler = "x".repeat(2048);
    writeFileSync(path, `${filler}\nkeep-1\nkeep-2\n`, "utf8");
    // Window 2 lines → chunk 2KB → starts inside the filler line.
    const lines = readTailLinesFromFile(path, 2);
    expect(lines).toEqual(["keep-1", "keep-2"]);
  });
});
