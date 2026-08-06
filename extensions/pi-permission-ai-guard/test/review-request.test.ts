import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { buildReviewRequestContext, reviewRequestCacheMaterial } from "#src/review-request.ts";

function makeDetails(overrides: Record<string, unknown> = {}): PromptPermissionDetails {
  return {
    requestId: "test-1",
    source: "tool_call",
    agentName: null,
    surface: "bash",
    value: "python3",
    command: "python3",
    message: "Run command",
    ...overrides,
  } as unknown as PromptPermissionDetails;
}

describe("buildReviewRequestContext", () => {
  it("keeps the complete bash action and canonical path boundary together", () => {
    // boundaryValue is non-null only for path surfaces (upstream contract:
    // ForwardedAccessFacts.boundaryValue is canonical for path, null otherwise).
    const request = buildReviewRequestContext(
      makeDetails({
        surface: "path",
        value: "./script.py",
        path: "./script.py",
        command: undefined,
        accessIntent: {
          surface: "path",
          matchValues: ["/project/script.py"],
          boundaryValue: "/real/project/script.py",
        },
      }),
      "path",
      "/project/script.py",
      "/project",
    );
    expect(request.canonicalBoundary).toBe("/real/project/script.py");
    expect(request.surface).toBe("path");
  });

  it("retains opaque and preview action context for the model", () => {
    const missing = buildReviewRequestContext(
      makeDetails({ surface: "mcp", value: "server:delete", command: undefined }),
      "mcp",
      "server:delete",
      "/project",
    );
    expect(missing.actionText).toBeUndefined();

    const preview = buildReviewRequestContext(
      makeDetails({
        command: undefined,
        toolInputPreview: `input ${"x".repeat(1_000)}…`,
      }),
      "extension",
      "web_fetch",
      "/project",
    );
    expect(preview.actionText).toBe(`input ${"x".repeat(1_000)}…`);
  });

  it("keeps an arbitrarily long bash command intact", () => {
    const command = "x".repeat(8_001);
    const request = buildReviewRequestContext(
      makeDetails({ command }),
      "bash",
      "python3",
      "/project",
    );
    expect(request.actionText).toBe(command);
  });

  it("makes action and boundary changes cache-distinct", () => {
    const base = buildReviewRequestContext(
      makeDetails({ command: "git status" }),
      "bash",
      "git",
      "/p",
    );
    const differentAction = buildReviewRequestContext(
      makeDetails({ command: "git clean -fd" }),
      "bash",
      "git",
      "/p",
    );
    const differentBoundary = { ...base, canonicalBoundary: "/real/p" };
    expect(reviewRequestCacheMaterial(base)).not.toBe(reviewRequestCacheMaterial(differentAction));
    expect(reviewRequestCacheMaterial(base)).not.toBe(
      reviewRequestCacheMaterial(differentBoundary),
    );
  });
});
