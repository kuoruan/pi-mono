/**
 * Log-tail-fs direct tests: the production tail adapter's windowing and
 * error contract, over an in-memory volume (node:fs is mock-backed via
 * `__mocks__/fs.cjs`) — the one seam where the 5000-line bound is
 * physically enforced (the reader's injected seam is tested in
 * decision-log-reader.test.ts; this pins the adapter's half).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { readTailLinesFromFile } from "#src/audit/log-tail-fs.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");

/** The virtual log path every test seeds. */
const LOG_PATH = "/logs/review.jsonl";

beforeEach(() => {
  vol.reset();
});

/**
 * Seed the volume's log with `n` numbered lines (line i reads `line-i`),
 * JSONL-shaped with a trailing newline (the production log's form).
 *
 * @param n - How many lines to write.
 */
function numberedLog(n: number): void {
  writeFile(LOG_PATH, `${Array.from({ length: n }, (_, i) => `line-${i}`).join("\n")}\n`);
}

describe("readTailLinesFromFile", () => {
  it("returns the trailing lines of a file shorter than the window", () => {
    numberedLog(3);
    expect(readTailLinesFromFile(LOG_PATH, 5000)).toEqual(["line-0", "line-1", "line-2"]);
  });

  it("reads only the LAST window lines when the log exceeds it (the 5000-line bound is physical)", () => {
    const n = 6000;
    numberedLog(n);
    const lines = readTailLinesFromFile(LOG_PATH, 5000);
    expect(lines).toHaveLength(5000);
    // The first surviving line is the newest one inside the window.
    expect(lines?.[0]).toBe("line-1000");
    expect(lines?.at(-1)).toBe(`line-${n - 1}`);
  });

  it("returns undefined for a missing file (the caller's friendly message)", () => {
    expect(readTailLinesFromFile("/logs/no-such-log.jsonl", 5000)).toBe(undefined);
  });

  it("drops the leading partial line when the chunk starts mid-line", () => {
    // A chunk-sized read starts at a byte offset: the first fragment is
    // usually a mid-line cut, and the adapter must not return it as a
    // whole line. Force the cut with one long first line.
    const filler = "x".repeat(2048);
    writeFile(LOG_PATH, `${filler}\nkeep-1\nkeep-2\n`);
    // Window 2 lines → chunk 2KB → starts inside the filler line.
    const lines = readTailLinesFromFile(LOG_PATH, 2);
    expect(lines).toEqual(["keep-1", "keep-2"]);
  });

  it("keeps every complete line when the chunk starts mid-codepoint (the drop absorbs the partial)", () => {
    // Multi-byte UTF-8: a start offset can land inside a codepoint. The
    // corrupted fragment lives only in the dropped first line; every
    // surviving line must decode whole.
    writeFile(LOG_PATH, Array.from({ length: 400 }, (_, i) => `中é记录-${i}\n`).join(""));
    const lines = readTailLinesFromFile(LOG_PATH, 3);
    expect(lines).toEqual([`中é记录-397`, `中é记录-398`, `中é记录-399`]);
  });

  it("returns the complete lines before a partial trailing record when the file ends mid-codepoint", () => {
    // A file cut mid-write: the final line is genuinely incomplete (the
    // tolerant parse drops it downstream); the lines before it stay whole.
    const full = Array.from({ length: 10 }, (_, i) => `中é记录-${i}\n`).join("");
    writeFile(LOG_PATH, full.slice(0, full.length - 2)); // cuts "9\n"
    const lines = readTailLinesFromFile(LOG_PATH, 3);
    expect(lines?.[0]).toBe(`中é记录-7`);
    expect(lines?.[1]).toBe(`中é记录-8`);
    expect(lines?.[2]).toBe(`中é记录-`); // the "9" went with the cut
  });
});
