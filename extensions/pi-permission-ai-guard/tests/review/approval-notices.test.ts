import { describe, expect, it } from "vitest";

import { configSchema } from "#src/config/config-schema.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { makeDetails, payload } from "#test/fixtures.ts";

import {
  baseConfig,
  makeEngine,
  makeFakeCompleteSimple,
  makeNotifySpy,
  makePipeline,
  makeQuery,
  noLog,
} from "./pipeline-helpers.ts";

describe("opt-in approval notices", () => {
  it("defaults off and rejects non-boolean values", () => {
    expect(baseConfig.notifyApprovals).toBe(false);
    expect(
      configSchema.parse({ provider: "anthropic", model: "test", notifyApprovals: true })
        .notifyApprovals,
    ).toBe(true);
    expect(
      configSchema.safeParse({ provider: "anthropic", model: "test", notifyApprovals: "true" })
        .success,
    ).toBe(false);
  });

  it("stays silent by default, even when the reviewer allows", async () => {
    const { notify, notifications } = makeNotifySpy();
    const authorize = createReviewPipeline(makePipeline({ notify }));
    expect(await authorize(makeDetails({ value: "pwd" }), makeQuery("ask"), noLog)).toEqual({
      kind: "allow",
    });
    expect(notifications).toEqual([]);
  });

  it("announces fresh and cached allows without echoing sensitive commands", async () => {
    let calls = 0;
    const { notify, notifications } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, notifyApprovals: true, cache: { maxEntries: 8 } },
        notify,
        engine: makeEngine({
          modelCall: async () => {
            calls++;
            return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
          },
        }),
      }),
    );
    const details = makeDetails({
      value: "echo sk-ant-api03-1234567890abcdefABCDEF1234567890abcdefABCDEF",
    });
    expect(await authorize(details, makeQuery("ask"), noLog)).toEqual({ kind: "allow" });
    expect(await authorize(details, makeQuery("ask"), noLog)).toEqual({ kind: "allow" });
    expect(calls).toBe(1);
    // Fresh reviews report their total cost (the fake call is ~0ms);
    // the replay names itself instead of restating a stale number.
    expect(notifications[0]![0]).toMatch(/^reviewer approved this request \([\d.]+m?s\)$/);
    expect(notifications[0]![1]).toBe("info");
    expect(notifications).toEqual([
      notifications[0],
      ["reviewer approved this request (cached)", "info"],
    ]);
  });

  it("does not mistake deterministic policy allows or uncovered surfaces for reviewer approvals", async () => {
    const { notify, notifications } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, notifyApprovals: true },
        notify,
      }),
    );
    expect(await authorize(makeDetails({ value: "pwd" }), makeQuery("allow"), noLog)).toEqual({
      kind: "defer",
    });
    expect(
      await authorize(makeDetails({ surface: "other", value: "pwd" }), makeQuery("ask"), noLog),
    ).toEqual({ kind: "defer" });
    expect(notifications).toEqual([]);
  });

  it("distinguishes mode-mapped allows from reviewer allows", async () => {
    const { notify, notifications } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          notifyApprovals: true,
          mode: "permissive",
          cache: { maxEntries: 8 },
        },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
          ]),
        }),
      }),
    );
    expect(await authorize(makeDetails({ value: "cmd" }), makeQuery("ask"), noLog)).toEqual({
      kind: "allow",
    });
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual([
      "permissive auto-approves non-allow verdicts — hard-tier denials still block",
      "warning",
    ]);
    expect(notifications[1]![0]).toMatch(
      /^mode \(permissive\) auto-approved this request \([\d.]+m?s\)$/,
    );
    expect(notifications[1]![1]).toBe("info");
    // The stored deny replays from cache and maps again — the tail names
    // the replay instead of restating the first call's latency.
    expect(await authorize(makeDetails({ value: "cmd" }), makeQuery("ask"), noLog)).toEqual({
      kind: "allow",
    });
    expect(notifications.at(-1)).toEqual([
      "mode (permissive) auto-approved this request (cached)",
      "info",
    ]);
  });

  it.each(["skill_read", "my_tool_write"])(
    "does not suppress unrelated %s surfaces ending in a directional suffix",
    async (surface) => {
      const { notify, notifications } = makeNotifySpy();
      const authorize = createReviewPipeline(
        makePipeline({
          config: { ...baseConfig, notifyApprovals: true, surfaces: [surface] },
          notify,
        }),
      );
      const details = makeDetails({
        surface,
        value: "ordinary request",
        payload: payload("tool", { surface, value: "ordinary request" }),
      });
      expect(await authorize(details, makeQuery("ask"), noLog)).toEqual({ kind: "allow" });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]![0]).toMatch(/^reviewer approved this request \([\d.]+m?s\)$/);
      expect(notifications[0]![1]).toBe("info");
    },
  );

  it.each([
    "path",
    "path_read",
    "path_write",
    "external_directory",
    "external_directory_read",
    "external_directory_write",
  ])("never claims final approval for bounded %s grants", async (surface) => {
    const { notify, notifications } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, notifyApprovals: true, surfaces: ["path", "external_directory"] },
        notify,
      }),
    );
    const kind = surface.startsWith("path") ? "path" : "external_directory";
    const details = makeDetails({
      surface,
      value: "/project/file",
      payload: payload(kind, { surface, value: "/project/file" }),
    });
    // Link still emits allow; the chain owner caps it to defer afterward.
    expect(await authorize(details, makeQuery("ask"), noLog)).toEqual({ kind: "allow" });
    expect(notifications).toEqual([]);
  });
});
