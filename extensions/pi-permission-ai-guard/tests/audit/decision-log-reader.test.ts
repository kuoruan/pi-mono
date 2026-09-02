/**
 * Decision-log-reader direct tests: the tail-read seam, path
 * resolution, tolerant parsing, and the missing-file contract — all
 * fixture-driven (no real log files).
 */

import { describe, expect, it } from "vitest";

import {
  readDecisionLog,
  readLogLines,
  reviewLogPath,
  type ReadTailLines,
} from "#src/audit/decision-log-reader.ts";

/**
 * A tail-read seam over an in-memory file body.
 *
 * @param body - The file body, or undefined to simulate a missing file.
 * @returns The seam function (last-n lines of the body, or undefined).
 */
function seam(body: string | undefined): ReadTailLines {
  return (path, n) => {
    if (body === undefined) return undefined;
    const lines = body.split("\n");
    return lines.slice(-n);
  };
}

describe("reviewLogPath", () => {
  it("resolves the conventional pps logs path under home", () => {
    expect(reviewLogPath("/home/u")).toBe(
      "/home/u/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl",
    );
  });
});

describe("readDecisionLog", () => {
  it("parses jsonl lines into entries in file order", () => {
    const body = [
      JSON.stringify({ event: "ai_guard.decision", gate: "model", requestId: "r1" }),
      JSON.stringify({ event: "permission_request.approved", requestId: "r1" }),
    ].join("\n");
    const entries = readDecisionLog("/h", { readTailLines: seam(body) });
    expect(entries).toHaveLength(2);
    expect(entries?.[0]?.event).toBe("ai_guard.decision");
    expect(entries?.[1]?.resolution ?? entries?.[1]?.event).toBe("permission_request.approved");
  });

  it("skips corrupt lines and blanks without failing the read", () => {
    const body = [
      "not json at all",
      "",
      JSON.stringify({ event: "ai_guard.decision", gate: "model" }),
      "{broken",
    ].join("\n");
    const entries = readDecisionLog("/h", { readTailLines: seam(body) });
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.gate).toBe("model");
  });

  it("returns undefined when the file cannot be read (missing log)", () => {
    expect(readDecisionLog("/h", { readTailLines: seam(undefined) })).toBeUndefined();
  });

  it("honors the tail window (the seam receives the line count)", () => {
    let seenCount = -1;
    const counting: ReadTailLines = (_path, n) => {
      seenCount = n;
      return [];
    };
    readDecisionLog("/h", { readTailLines: counting });
    expect(seenCount).toBe(5000);
  });
});

describe("readLogLines (the explicit-path entry — the log-stats script's seam)", () => {
  it("parses an explicit path's tail exactly like the home-resolving entry", () => {
    const body = '{"event":"a"}\n{"event":"b"}\nnot json\n{"event":"c"}';
    expect(readLogLines("/any/path.jsonl", { readTailLines: seam(body) })).toEqual([
      { event: "a" },
      { event: "b" },
      { event: "c" },
    ]);
  });

  it("passes the explicit path through to the seam, not the home-derived one", () => {
    let seenPath = "";
    const recording: ReadTailLines = (path) => {
      seenPath = path;
      return [];
    };
    readLogLines("/custom/log.jsonl", { readTailLines: recording });
    expect(seenPath).toBe("/custom/log.jsonl");
  });

  it("returns undefined for an unreadable explicit path", () => {
    expect(readLogLines("/gone.jsonl", { readTailLines: seam(undefined) })).toBeUndefined();
  });
});
