import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { resolveReviewTarget } from "#src/ask-eligibility.ts";

/**
 * Build a PromptPermissionDetails-shaped object for tests.
 *
 * @param overrides - Field overrides applied over the default details.
 * @returns A `PromptPermissionDetails` for testing.
 */
function makeDetails(overrides: Record<string, unknown> = {}): PromptPermissionDetails {
  return {
    requestId: "test-1",
    source: "tool_call",
    agentName: null,
    message: "Run command",
    surface: "bash",
    value: "ls -la",
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
    // Namespaced surface matches *:*
    expect(
      resolveReviewTarget(makeDetails({ surface: "my-ext:custom-tool", value: "run" }), {
        surfaces: ["*:*"],
      }),
    ).toEqual({ surface: "my-ext:custom-tool", target: "run" });
    // Non-namespaced surface (bash) does NOT match *:*
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls" }), { surfaces: ["*:*"] }),
    ).toEqual({ reason: "surface-unmatched" });
  });

  it("excludes surfaces matching !pattern even when * is present", () => {
    const surfaces = ["*", "!external_directory", "!path"];
    // external_directory is excluded
    expect(
      resolveReviewTarget(makeDetails({ surface: "external_directory", value: "x" }), { surfaces }),
    ).toEqual({ reason: "surface-unmatched" });
    // path is excluded
    expect(resolveReviewTarget(makeDetails({ surface: "path", value: "x" }), { surfaces })).toEqual(
      {
        reason: "surface-unmatched",
      },
    );
    // bash is not excluded → resolved
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls" }), { surfaces }),
    ).toEqual({ surface: "bash", target: "ls" });
  });

  it("excludes with glob patterns", () => {
    const surfaces = ["*", "!ext:*"];
    // ext:tool is excluded by !ext:*
    expect(
      resolveReviewTarget(makeDetails({ surface: "ext:tool", value: "x" }), { surfaces }),
    ).toEqual({ reason: "surface-unmatched" });
    // other:tool is not excluded
    expect(
      resolveReviewTarget(makeDetails({ surface: "other:tool", value: "x" }), { surfaces }),
    ).toEqual({ surface: "other:tool", target: "x" });
  });

  it("treats excludes-only config as match-none (no includes)", () => {
    // No includes → nothing matches, regardless of excludes
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
      resolveReviewTarget(makeDetails({ surface: null, value: "ls" }), {
        surfaces: ["bash"],
      }),
    ).toEqual({ reason: "surface-unmatched" });
  });

  it("escapes regex specials in literal parts", () => {
    // A surface with a regex-special char (.) must match literally, not as a wildcard.
    expect(
      resolveReviewTarget(makeDetails({ surface: "a.b:tool", value: "x" }), {
        surfaces: ["a.b:*"],
      }),
    ).toEqual({ surface: "a.b:tool", target: "x" });
    // "axb:tool" must NOT match "a.b:*"
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
    // For the path surface, matchValues is [absolute, cwd-relative, canonical].
    const result = resolveReviewTarget(
      makeDetails({
        surface: "path",
        value: null,
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

  it("extracts target from value field", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "ls -la" }), {
        surfaces: ["bash"],
      }),
    ).toEqual({ surface: "bash", target: "ls -la" });
  });

  it("extracts target from command field", () => {
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: null, command: "git status" }), {
        surfaces: ["bash"],
      }),
    ).toEqual({ surface: "bash", target: "git status" });
  });

  it("extracts target from path field", () => {
    expect(
      resolveReviewTarget(
        makeDetails({ surface: "bash", value: null, command: null, path: "/src/file.ts" }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ surface: "bash", target: "/src/file.ts" });
  });

  it("extracts target from target field", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "bash",
          value: null,
          command: null,
          path: null,
          target: "safe-cmd",
        }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ surface: "bash", target: "safe-cmd" });
  });

  it("extracts target from toolName field", () => {
    expect(
      resolveReviewTarget(
        makeDetails({
          surface: "mcp",
          value: null,
          command: null,
          path: null,
          target: null,
          toolName: "my-tool",
        }),
        { surfaces: ["mcp"] },
      ),
    ).toEqual({ surface: "mcp", target: "my-tool" });
  });

  it("extracts target from skillName field", () => {
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
        }),
        { surfaces: ["bash"] },
      ),
    ).toEqual({ reason: "no-target" });
  });

  it("ignores empty-string fields in the fallback chain", () => {
    // An empty value should fall through to command.
    expect(
      resolveReviewTarget(makeDetails({ surface: "bash", value: "", command: "git status" }), {
        surfaces: ["bash"],
      }),
    ).toEqual({ surface: "bash", target: "git status" });
  });
});
