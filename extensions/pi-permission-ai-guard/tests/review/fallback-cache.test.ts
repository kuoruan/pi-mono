import { describe, expect, it } from "vitest";

import { configSchema, hasTypesafeProvider } from "#src/config/config-schema.ts";
import { createLlmEngine } from "#src/review/engines/llm/engine.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { makeDetails } from "#test/fixtures.ts";

import {
  baseConfig,
  defaultRegistry,
  fakeModel,
  makeFakeCompleteSimple,
  makePipeline,
  makeQuery,
  noLog,
} from "./pipeline-helpers.ts";

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

  it("retries primary after an LLM backup, then caches the healthy primary", async () => {
    const calls: string[] = [];
    const config = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      fallbacks: [{ provider: "openai", model: "backup" }],
      cache: { maxEntries: 8 },
    });
    if (hasTypesafeProvider(config)) throw new Error("expected LLM config");
    const engine = createLlmEngine({
      config,
      registry: defaultRegistry({
        find: (provider, model) => ({ ...fakeModel, provider, id: model }) as never,
      }),
      modelCall: async (model) => {
        calls.push(model.id);
        if (calls.length === 1) {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        return makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }])();
      },
    });
    const authorize = createReviewPipeline(makePipeline({ config, engine }));
    const ask = () => authorize(makeDetails({ value: "pwd" }), makeQuery("ask"), noLog);
    expect(await ask()).toEqual({ kind: "allow" });
    expect(await ask()).toEqual({ kind: "allow" });
    expect(await ask()).toEqual({ kind: "allow" });
    expect(calls).toEqual(["primary", "backup", "primary"]);
  });
});
