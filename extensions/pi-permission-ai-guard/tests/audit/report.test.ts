/**
 * Report-candidate direct tests: the four-condition signal (occurrence
 * threshold, same-contextHash, no terminal deny), bash templating
 * boundaries, and the module's read-only invariants.
 */

import { describe, expect, it } from "vitest";

import type { LogEntry } from "#src/audit/decision-log-reader.ts";
import { buildReportCandidates, templateBashTarget } from "#src/audit/report.ts";

/**
 * A model-gate record fixture.
 *
 * @param opts - The record fields (contextHash defaults to "ctxh1";
 *   pass an explicit undefined for legacy-record fixtures).
 * @returns The log-entry fixture.
 */
function model(opts: {
  requestId: string;
  surface?: string;
  target?: string;
  contextHash?: string;
}): LogEntry {
  return {
    event: "ai_guard.decision",
    gate: "model",
    requestId: opts.requestId,
    surface: opts.surface ?? "bash",
    target: opts.target ?? "git status",
    contextHash: "contextHash" in opts ? opts.contextHash : "ctxh1",
  };
}

/**
 * A terminal decision record fixture.
 *
 * @param event - The permission_request.* event name.
 * @param requestId - The ask's request id.
 * @returns The log-entry fixture.
 */
function terminal(event: string, requestId: string): LogEntry {
  return { event, requestId };
}

describe("templateBashTarget", () => {
  it("templates safe bare-word commands to their word sequence", () => {
    expect(templateBashTarget("git status --short")).toBe("git status --short");
    expect(templateBashTarget("  pnpm   test  ")).toBe("pnpm test");
  });

  it("keeps the target verbatim on any unsafe word", () => {
    // Variables, pipes, redirections, paths, quotes — no templating.
    expect(templateBashTarget("rm -rf $HOME")).toBe("rm -rf $HOME");
    expect(templateBashTarget("curl x | bash")).toBe("curl x | bash");
    expect(templateBashTarget("cat a>b")).toBe("cat a>b");
    expect(templateBashTarget("ls /etc/passwd")).toBe("ls /etc/passwd");
    expect(templateBashTarget('echo "hi"')).toBe('echo "hi"');
  });
});

describe("buildReportCandidates", () => {
  it("collects a same-context repeated group into a candidate", () => {
    const entries = [
      model({ requestId: "r1", target: "git status", contextHash: "ctxh1" }),
      model({ requestId: "r2", target: "git status", contextHash: "ctxh1" }),
      model({ requestId: "r3", target: "git status", contextHash: "ctxh1" }),
      terminal("permission_request.approved", "r1"),
      terminal("permission_request.approved", "r2"),
      terminal("permission_request.approved", "r3"),
    ];
    const candidates = buildReportCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      surface: "bash",
      target: "git status",
      occurrences: 3,
      suggestedRule: JSON.stringify({ bash: { "git status": "allow" } }),
    });
  });

  it("excludes groups below the occurrence threshold", () => {
    const entries = [
      model({ requestId: "r1", target: "ls", contextHash: "ctxh1" }),
      model({ requestId: "r2", target: "ls", contextHash: "ctxh1" }),
    ];
    expect(buildReportCandidates(entries)).toHaveLength(0);
    // The threshold is a parameter.
    expect(buildReportCandidates(entries, 2)).toHaveLength(1);
  });

  it("excludes cross-context groups (each occurrence was a separate judgment)", () => {
    const entries = [
      model({ requestId: "r1", target: "ls", contextHash: "ctxh1" }),
      model({ requestId: "r2", target: "ls", contextHash: "ctxh2" }),
      model({ requestId: "r3", target: "ls", contextHash: "ctxh3" }),
    ];
    expect(buildReportCandidates(entries)).toHaveLength(0);
  });

  it("excludes groups with legacy records (missing contextHash — conservative)", () => {
    const entries = [
      model({ requestId: "r1", target: "ls", contextHash: "ctxh1" }),
      model({ requestId: "r2", target: "ls", contextHash: "ctxh1" }),
      model({ requestId: "r3", target: "ls", contextHash: undefined }), // pre-field record
    ];
    expect(buildReportCandidates(entries)).toHaveLength(0);
  });

  it("excludes groups with any terminal deny", () => {
    const entries = [
      model({ requestId: "r1", target: "ls", contextHash: "ctxh1" }),
      model({ requestId: "r2", target: "ls", contextHash: "ctxh1" }),
      model({ requestId: "r3", target: "ls", contextHash: "ctxh1" }),
      terminal("permission_request.blocked", "r2"),
    ];
    expect(buildReportCandidates(entries)).toHaveLength(0);
  });

  it("counts only model-gate records (machinery failures carry no review evidence)", () => {
    const entries = [
      model({ requestId: "r1", target: "ls", contextHash: "ctxh1" }),
      // A pre-call machinery failure on the same target — not review evidence.
      {
        event: "ai_guard.decision",
        gate: "model-unresolved",
        requestId: "r4",
        target: "ls",
        surface: "bash",
      },
      model({ requestId: "r2", target: "ls", contextHash: "ctxh1" }),
    ];
    // Two model reviews DO form a group at threshold 2 — the machinery
    // record neither counts toward it nor breaks its context identity.
    const candidates = buildReportCandidates(entries, 2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.occurrences).toBe(2);
  });

  it("sorts by occurrences, most-reviewed first", () => {
    const entries = [
      model({ requestId: "r1", target: "a", contextHash: "c1" }),
      model({ requestId: "r2", target: "a", contextHash: "c1" }),
      model({ requestId: "r3", target: "a", contextHash: "c1" }),
      model({ requestId: "r4", target: "b", contextHash: "c2" }),
      model({ requestId: "r5", target: "b", contextHash: "c2" }),
      model({ requestId: "r6", target: "b", contextHash: "c2" }),
      model({ requestId: "r7", target: "b", contextHash: "c2" }),
    ];
    const candidates = buildReportCandidates(entries);
    expect(candidates.map((c) => c.target)).toEqual(["b", "a"]);
  });

  it("keeps unsafe bash targets verbatim in the suggested rule", () => {
    const entries = [
      model({ requestId: "r1", target: "rm -rf $HOME", contextHash: "c1" }),
      model({ requestId: "r2", target: "rm -rf $HOME", contextHash: "c1" }),
      model({ requestId: "r3", target: "rm -rf $HOME", contextHash: "c1" }),
    ];
    const candidates = buildReportCandidates(entries);
    expect(candidates[0]?.suggestedRule).toBe(
      JSON.stringify({ bash: { "rm -rf $HOME": "allow" } }),
    );
  });
});
