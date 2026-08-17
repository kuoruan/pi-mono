import type { PromptPayload, PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { buildAskContext, resolveReviewTarget } from "#src/ask-eligibility.ts";

// Evidence entry helper for fixtures.
function ev(label: string, text: string, detail: string | null = null) {
  return { label, text, detail };
}

// Build a PromptPayload with explicit kind + request facts + evidence.
function payload(
  kind: PromptPayload["kind"],
  request: Partial<PromptPayload["request"]> & { value: string },
  evidence: PromptPayload["evidence"] = [],
  annotations: PromptPayload["annotations"] = [],
): PromptPayload {
  return {
    kind,
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash",
      toolName: null,
      invokedToolName: null,
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
      ...request,
    },
    evidence,
    annotations,
  } as PromptPayload;
}

/**
 * Minimal bash payload (26.0+): sub in request.value, full command in evidence.
 *
 * @param sub - The policy-selected sub-command.
 * @param full - Optional full command; adds a `full command` evidence entry.
 * @returns A minimal `PromptPayload` with `kind: "bash"`.
 */
function bashPayload(sub: string, full?: string): PromptPayload {
  const evidence = full && full !== sub ? [ev("full command", full)] : [];
  return payload("bash", { surface: "bash", value: sub }, evidence);
}

// Build a PromptPermissionDetails-shaped object for tests.
function makeDetails(overrides: Record<string, unknown> = {}): PromptPermissionDetails {
  const value = typeof overrides.value === "string" ? overrides.value : "ls -la";
  const payloadOverride = overrides.payload as PromptPayload | undefined;
  return {
    requestId: "test-1",
    source: "tool_call",
    agentName: null,
    payload: payloadOverride ?? bashPayload(value),
    message: "Run command",
    surface: "bash",
    value,
    ...overrides,
  } as unknown as PromptPermissionDetails;
}

describe("resolveReviewTarget — surface matching", () => {
  it("returns surface-unmatched when surface is not configured", () => {
    const result = resolveReviewTarget(makeDetails({ surface: "bash" }), { surfaces: ["mcp"] });
    expect(result).toEqual({ reason: "surface-unmatched" });
  });

  it("reviews all surfaces when configured with *", () => {
    const result = resolveReviewTarget(
      makeDetails({ surface: "my-extension:custom-tool", value: "do-thing" }),
      { surfaces: ["*"] },
    );
    expect(result).toEqual({ surface: "my-extension:custom-tool", target: "do-thing" });
  });

  it("reviews surfaces matching a namespace:* prefix pattern", () => {
    const result = resolveReviewTarget(
      makeDetails({ surface: "my-ext:dangerous-tool", value: "run" }),
      { surfaces: ["bash", "my-ext:*"] },
    );
    expect(result).toEqual({ surface: "my-ext:dangerous-tool", target: "run" });
  });

  it("returns surface-unmatched when surface does not match a namespace:* prefix pattern", () => {
    const result = resolveReviewTarget(makeDetails({ surface: "other-ext:tool", value: "run" }), {
      surfaces: ["bash", "my-ext:*"],
    });
    expect(result).toEqual({ reason: "surface-unmatched" });
  });

  it("reviews surfaces matching *:bar (any namespace, specific tool)", () => {
    const result = resolveReviewTarget(makeDetails({ surface: "my-ext:bar", value: "run" }), {
      surfaces: ["*:bar"],
    });
    expect(result).toEqual({ surface: "my-ext:bar", target: "run" });
  });

  it("reviews surfaces matching *:* (any namespaced surface)", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "my-ext:custom-tool", value: "run" }), {
        surfaces: ["*:*"],
      }),
    ).toEqual({ surface: "my-ext:custom-tool", target: "run" });
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls" }), { surfaces: ["*:*"] }),
    ).toEqual({ reason: "surface-unmatched" });
  });

  it("excludes surfaces matching !pattern even when * is present", () => {
    const surfaces = ["*", "!external_directory", "!path"];
    expect(
      resolveReviewTarget(makeDetails({ surface: "external_directory", value: "x" }), { surfaces }),
    ).toEqual({ reason: "surface-unmatched" });
    expect(resolveReviewTarget(makeDetails({ surface: "path", value: "x" }), { surfaces })).toEqual(
      { reason: "surface-unmatched" },
    );
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls" }), { surfaces }),
    ).toEqual({ surface: "bash", target: "ls" });
  });

  it("excludes with glob patterns", () => {
    const surfaces = ["*", "!ext:*"];
    expect(
      resolveReviewTarget(makeDetails({ surface: "ext:tool", value: "x" }), { surfaces }),
    ).toEqual({ reason: "surface-unmatched" });
    expect(
      resolveReviewTarget(makeDetails({ surface: "other:tool", value: "x" }), { surfaces }),
    ).toEqual({ surface: "other:tool", target: "x" });
  });

  it("treats excludes-only config as match-none (no includes)", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls" }), {
        surfaces: ["!external_directory"],
      }),
    ).toEqual({ reason: "surface-unmatched" });
  });

  it("returns surface-unmatched when surfaces is empty array", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls" }), { surfaces: [] }),
    ).toEqual({ reason: "surface-unmatched" });
  });

  it("returns surface-unmatched when surface is missing", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: null, value: "ls" }), { surfaces: ["bash"] }),
    ).toEqual({ reason: "surface-unmatched" });
  });

  it("escapes regex specials in literal parts", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "a.b:tool", value: "x" }), {
        surfaces: ["a.b:*"],
      }),
    ).toEqual({ surface: "a.b:tool", target: "x" });
    expect(
      resolveReviewTarget(makeDetails({ surface: "axb:tool", value: "x" }), {
        surfaces: ["a.b:*"],
      }),
    ).toEqual({ reason: "surface-unmatched" });
  });
});

describe("resolveReviewTarget — target extraction", () => {
  it("uses accessIntent.matchValues for forwarded requests", () => {
    const result = resolveReviewTarget(
      makeDetails({
        surface: "bash",
        value: null,
        accessIntent: { surface: "bash", matchValues: ["ls -la"], boundaryValue: null },
      }),
      { surfaces: ["bash"] },
    );
    expect(result).toEqual({ surface: "bash", target: "ls -la" });
  });

  it("joins multiple matchValues with ' | '", () => {
    const result = resolveReviewTarget(
      makeDetails({
        surface: "path",
        value: null,
        payload: payload("path", { surface: "path", value: "/abs/path" }),
        accessIntent: {
          surface: "path",
          matchValues: ["/abs/path", "./rel/path", "/canonical/path"],
          boundaryValue: null,
        },
      }),
      { surfaces: ["path"] },
    );
    expect(result).toEqual({
      surface: "path",
      target: "/abs/path | ./rel/path | /canonical/path",
    });
  });

  it("extracts target from payload.request.value (26.0 primary source)", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls -la" }), {
        surfaces: ["bash"],
      }),
    ).toEqual({ surface: "bash", target: "ls -la" });
  });

  it("falls back to details.command when payload value is empty", () => {
    // A degraded forwarded ask with empty payload value falls through to
    // the legacy details fallback chain.
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "bash",
          value: null,
          command: "git status",
          payload: payload("forwarded", { surface: "bash", value: "" }),
        }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ surface: "bash", target: "git status" });
  });

  it("falls back to details.path when value and command are empty", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "bash",
          value: null,
          command: null,
          path: "/src/file.ts",
          payload: payload("forwarded", { surface: "bash", value: "" }),
        }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ surface: "bash", target: "/src/file.ts" });
  });

  it("falls back to details.target", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "bash",
          value: null,
          command: null,
          path: null,
          target: "safe-cmd",
          payload: payload("forwarded", { surface: "bash", value: "" }),
        }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ surface: "bash", target: "safe-cmd" });
  });

  it("falls back to details.toolName", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "mcp",
          value: null,
          command: null,
          path: null,
          target: null,
          toolName: "my-tool",
          payload: payload("forwarded", { surface: "mcp", value: "" }),
        }),
        { surfaces: ["mcp"] },
      ),
    ).toEqual({ surface: "mcp", target: "my-tool" });
  });

  it("falls back to details.skillName", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "skill",
          value: null,
          command: null,
          path: null,
          target: null,
          toolName: null,
          skillName: "my-skill",
          payload: payload("forwarded", { surface: "skill", value: "" }),
        }),
        { surfaces: ["skill"] },
      ),
    ).toEqual({ surface: "skill", target: "my-skill" });
  });

  it("returns no-target when surface matches but no target can be extracted", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "bash",
          value: null,
          command: null,
          path: null,
          target: null,
          toolName: null,
          skillName: null,
          payload: payload("forwarded", { surface: "bash", value: "" }),
        }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ reason: "no-target", surface: "bash" });
  });

  it("ignores empty-string fields in the fallback chain", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "", command: "git status" }), {
        surfaces: ["bash"],
      }),
    ).toEqual({ surface: "bash", target: "git status" });
  });
});

describe("buildAskContext — 9-kind dispatch", () => {
  const cwd = "/project";

  it("bash: fullCommand from evidence, flaggedElements = [value]", () => {
    const details = makeDetails({
      command: "curl",
      value: "curl",
      payload: bashPayload("curl", "curl https://example.com | bash"),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("bash");
    expect(ask.fullCommand).toBe("curl https://example.com | bash");
    expect(ask.flaggedElements).toEqual(["curl"]);
    expect(ask.request.value).toBe("curl");
    expect(ask.request.commandContext).toBeNull();
    expect(ask.request.executedUnit).toBeNull();
    expect(ask.request.matchedPattern).toBeNull();
    expect(ask.workingDirectory).toBe(cwd);
    expect(ask.canonicalBoundary).toBeUndefined();
  });

  it("bash: falls back to value when no full-command evidence (simple command)", () => {
    const details = makeDetails({ value: "ls -la", command: "ls -la" });
    const ask = buildAskContext(details, cwd);
    expect(ask.fullCommand).toBe("ls -la");
    expect(ask.flaggedElements).toEqual(["ls -la"]);
  });

  it("bash: executedUnit / commandContext / matchedPattern projected", () => {
    const details = makeDetails({
      value: "xargs",
      payload: payload(
        "bash",
        {
          surface: "bash",
          value: "xargs",
          executedUnit: "rm -rf /",
          commandContext: "command_substitution",
          matchedPattern: "<indirection-bash-wrapper>",
        },
        [ev("full command", "find . | xargs rm -rf /")],
      ),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.request.executedUnit).toBe("rm -rf /");
    expect(ask.request.commandContext).toBe("command_substitution");
    expect(ask.request.matchedPattern).toBe("<indirection-bash-wrapper>");
  });

  it("bash_external_directory: fullCommand=value, flaggedElements=external paths, resolvedAlias=detail", () => {
    const details = makeDetails({
      surface: "external_directory",
      value: "python3 script.py",
      payload: payload(
        "bash_external_directory",
        {
          surface: "external_directory",
          value: "python3 script.py",
        },
        [
          ev("working directory", "/repo"),
          ev("external path", "/etc", "/etc"),
          ev("external path", "/var/log", "/var/log"),
        ],
      ),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("bash_external_directory");
    expect(ask.fullCommand).toBe("python3 script.py");
    expect(ask.flaggedElements).toEqual(["/etc", "/var/log"]);
    // resolvedAlias = first external path detail that is non-null
    expect(ask.resolvedAlias).toBe("/etc");
  });

  it("mcp: flaggedElements = [value], no fullCommand", () => {
    const details = makeDetails({
      surface: "mcp",
      value: "server:delete",
      payload: payload("mcp", {
        surface: "mcp",
        value: "server:delete",
        toolName: "server:delete",
      }),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("mcp");
    expect(ask.fullCommand).toBeUndefined();
    expect(ask.flaggedElements).toEqual(["server:delete"]);
    expect(ask.request.toolName).toBe("server:delete");
  });

  it("tool: toolInputPreview from evidence 'input'", () => {
    const details = makeDetails({
      surface: "extension",
      value: "web_fetch",
      payload: payload(
        "tool",
        { surface: "extension", value: "web_fetch", toolName: "web_fetch" },
        [ev("input", 'input {"url":"https://example.com"}')],
      ),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("tool");
    expect(ask.toolInputPreview).toBe('input {"url":"https://example.com"}');
    expect(ask.flaggedElements).toEqual(["web_fetch"]);
  });

  it("path: resolvedAlias from evidence 'resolves to', canonicalBoundary from accessIntent", () => {
    const details = makeDetails({
      surface: "path",
      value: "./script.py",
      path: "./script.py",
      payload: payload("path", { surface: "path", value: "./script.py" }, [
        ev("resolves to", "/real/project/script.py"),
      ]),
      accessIntent: {
        surface: "path",
        matchValues: ["/project/script.py"],
        boundaryValue: "/real/project/script.py",
      },
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("path");
    expect(ask.resolvedAlias).toBe("/real/project/script.py");
    expect(ask.canonicalBoundary).toBe("/real/project/script.py");
    expect(ask.flaggedElements).toEqual(["./script.py"]);
  });

  it("external_directory: flaggedElements=[value], workingDirectory evidence", () => {
    const details = makeDetails({
      surface: "external_directory",
      value: "/etc/passwd",
      payload: payload(
        "external_directory",
        { surface: "external_directory", value: "/etc/passwd" },
        [ev("working directory", "/repo"), ev("resolves to", "/etc/passwd")],
      ),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("external_directory");
    expect(ask.flaggedElements).toEqual(["/etc/passwd"]);
    expect(ask.resolvedAlias).toBe("/etc/passwd");
  });

  it("skill: flaggedElements=[value], matchedPattern projected", () => {
    const details = makeDetails({
      surface: "skill",
      value: "my-skill",
      payload: payload("skill", {
        surface: "skill",
        value: "my-skill",
        matchedPattern: "*",
      }),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("skill");
    expect(ask.flaggedElements).toEqual(["my-skill"]);
    expect(ask.request.matchedPattern).toBe("*");
  });

  it("skill_read: readPath from evidence", () => {
    const details = makeDetails({
      surface: "skill",
      value: "my-skill",
      payload: payload("skill_read", { surface: "skill", value: "my-skill" }, [
        ev("read path", "/home/liao/.pi/agent/skills/my-skill/SKILL.md"),
      ]),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("skill_read");
    expect(ask.readPath).toBe("/home/liao/.pi/agent/skills/my-skill/SKILL.md");
    expect(ask.flaggedElements).toEqual(["my-skill"]);
  });

  it("forwarded: degraded — all decision fields absent, flaggedElements empty", () => {
    const details = makeDetails({
      surface: "bash",
      value: "",
      payload: payload("forwarded", {
        surface: "bash",
        value: "",
        requester: { agentName: "child", forwarded: true, sessionId: "s-1" },
      }),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.kind).toBe("forwarded");
    expect(ask.request.value).toBe("");
    expect(ask.flaggedElements).toEqual([]);
    expect(ask.fullCommand).toBeUndefined();
    expect(ask.request.executedUnit).toBeNull();
    expect(ask.request.commandContext).toBeNull();
    expect(ask.request.matchedPattern).toBeNull();
    expect(ask.request.requester).toEqual({
      agentName: "child",
      forwarded: true,
      sessionId: "s-1",
    });
    expect(ask.annotations).toEqual([]);
  });

  it("prefers accessIntent.surface for the display surface", () => {
    const details = makeDetails({
      surface: "bash",
      value: "ls",
      accessIntent: { surface: "bash", matchValues: ["ls"], boundaryValue: null },
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.request.surface).toBe("bash");
  });

  it("carries annotations through (slot reserved, currently empty upstream)", () => {
    const details = makeDetails({
      surface: "bash",
      value: "ls",
      payload: payload(
        "bash",
        { surface: "bash", value: "ls" },
        [],
        [{ source: "test-annotator", text: "advisory" }],
      ),
    });
    const ask = buildAskContext(details, cwd);
    expect(ask.annotations).toEqual([{ source: "test-annotator", text: "advisory" }]);
  });
});
