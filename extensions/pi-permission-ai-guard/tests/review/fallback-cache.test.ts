import { describe, expect, it } from "vitest";

import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { makeDetails } from "#test/fixtures.ts";

import { baseConfig, makePipeline, makeQuery, noLog } from "./pipeline-helpers.ts";

describe("fallback verdict cache", () => {
  it("rechecks the primary after a backup decision, then caches a primary success", async () => {
    let reviews = 0;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { maxEntries: 8 } },
        engine: {
          review: async () => {
            reviews++;
            return {
              outcome: { verdict: { kind: "allow" }, latencyMs: 1 },
              modelId: reviews === 1 ? "typesafe/backup (fallback 1)" : "typesafe/primary",
              cacheable: reviews !== 1,
            };
          },
        },
      }),
    );
    const ask = () => authorize(makeDetails({ value: "ls" }), makeQuery("ask"), noLog);
    expect(await ask()).toEqual({ kind: "allow" });
    expect(await ask()).toEqual({ kind: "allow" });
    expect(reviews).toBe(2);
    expect(await ask()).toEqual({ kind: "allow" });
    expect(reviews).toBe(2);
  });
});
