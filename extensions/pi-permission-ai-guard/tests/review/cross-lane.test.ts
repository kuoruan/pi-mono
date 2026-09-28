/**
 * Cross-lane pool tests: Jev primary → LLM backup and the reverse, through
 * the real adapters with faked backends. Pins that the pool loop is
 * lane-blind: failover, audit, and cacheability work across lanes.
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";

import { FALLBACK_EVENT } from "#src/audit/events.ts";
import { configSchema } from "#src/config/config-schema.ts";
import type { ModelCallFn } from "#src/model/model-review.ts";
import {
  buildReviewerPool,
  resolveLaneInstructions,
  resolvePoolEndpoints,
} from "#src/review/build-pool.ts";
import { createJevAdapter } from "#src/review/engines/jev/adapter.ts";
import type {
  TypesafeClientLike,
  TypesafeSystemOneResponse,
} from "#src/review/engines/jev/client.ts";
import { createLlmAdapter } from "#src/review/engines/llm/adapter.ts";
import { FALLBACK_TIMEOUT_DEFAULT_MS, createReviewerPool } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";
import { makeDetails } from "#test/fixtures.ts";

import { defaultRegistry, fakeModel } from "./pipeline-helpers.ts";

function recordingLog() {
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const log = {
    review: (event: string, details: Record<string, unknown>) => events.push({ event, details }),
    debug: (event: string, details: Record<string, unknown>) => events.push({ event, details }),
  };
  return { events, log };
}

const reviewCtx = (log: ReturnType<typeof recordingLog>["log"]) => ({
  transcript: { trustedIntent: ["check"], toolCalls: [], strippedCount: 0 },
  request: { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" },
  log,
  requestId: "cross-lane-test",
});

function jevAllow(): TypesafeSystemOneResponse {
  return {
    model: "jev-test",
    usage: { input_tokens: 1, output_tokens: 0 },
    answers: {
      danger_category: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} },
      intent_match: { type: "noul", noul: 0.9 },
      risk: { type: "score", score: 0.2, confidence: 0.9, legend: {}, probabilities: {} },
    } as TypesafeSystemOneResponse["answers"],
  };
}

function llmAllow(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: '{"verdict":"allow"}' }],
    stopReason: "stop",
    model: "test",
    provider: "test",
    api: "anthropic-messages",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

const httpError = (status: number) =>
  APIError.fromResponse(status, { error: "no capacity" }, new Headers());

const registry = defaultRegistry({
  find: (provider, model) => ({ ...fakeModel, provider, id: model }) as Model<any>,
});

const llmAllowCall: ModelCallFn = async () => llmAllow();

describe("cross-lane failover", () => {
  it("fails over from a Jev primary to an LLM backup", async () => {
    const { events, log } = recordingLog();
    const engine = createReviewerPool({
      endpoints: [
        {
          lane: "jev",
          provider: { type: "typesafe", baseUrl: "https://primary.example", apiKey: "k" },
          model: "jev-1.13",
          timeoutMs: 5000,
        },
        { lane: "llm", provider: "anthropic", model: "backup", timeoutMs: 5000 },
      ],
      adapters: {
        jev: createJevAdapter({
          config: {
            typesafe: { intentThreshold: 0.5, riskThreshold: 0.5, confidenceThreshold: 0.5 },
            instructions: null,
          },
          createClient: () => ({
            systemOne: async () => {
              throw httpError(429);
            },
          }),
        }),
        llm: createLlmAdapter({
          config: { reasoning: "off", maxTokens: 4096, instructions: null },
          registry,
          modelCall: llmAllowCall,
        }),
      },
    });
    const result = await engine.review(reviewCtx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("anthropic/backup (fallback 1)");
    expect(result.cacheable).toBe(false);
    expect(events.map((e) => e.event)).toEqual([FALLBACK_EVENT]);
    expect(events[0]?.details).toMatchObject({ failedEndpoint: 0, reason: "http-429" });
  });

  it("fails over from an LLM primary to a Jev backup", async () => {
    const { events, log } = recordingLog();
    const safeJev: TypesafeClientLike = { systemOne: async () => jevAllow() };
    const engine = createReviewerPool({
      endpoints: [
        { lane: "llm", provider: "anthropic", model: "primary", timeoutMs: 5000 },
        {
          lane: "jev",
          provider: { type: "typesafe", baseUrl: "https://backup.example", apiKey: "k" },
          model: "jev-1.13",
          timeoutMs: 5000,
        },
      ],
      adapters: {
        llm: createLlmAdapter({
          config: { reasoning: "off", maxTokens: 4096, instructions: null },
          registry,
          modelCall: async () => {
            throw Object.assign(new Error("busy"), { status: 503 });
          },
        }),
        jev: createJevAdapter({
          config: {
            typesafe: { intentThreshold: 0.5, riskThreshold: 0.5, confidenceThreshold: 0.5 },
            instructions: null,
          },
          createClient: () => safeJev,
        }),
      },
    });
    const result = await engine.review(reviewCtx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("typesafe/jev-1.13 (fallback 1)");
    expect(result.cacheable).toBe(false);
    // The LLM attempt emits its call-failure debug record before the hop.
    expect(events.map((e) => e.event)).toContain(FALLBACK_EVENT);
    expect(events.find((e) => e.event === FALLBACK_EVENT)?.details).toMatchObject({
      reason: "http-503",
    });
  });

  it("discounts the fallback timeout default and honors explicit entries", () => {
    expect(FALLBACK_TIMEOUT_DEFAULT_MS).toBe(10_000);
    const config = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      timeoutMs: 60_000,
      fallbacks: [
        { provider: "openai", model: "implicit" },
        { provider: "openai", model: "explicit", timeoutMs: 3_000 },
      ],
    });
    const [, implicit, explicit] = resolvePoolEndpoints(config);
    expect(implicit?.timeoutMs).toBe(10_000);
    expect(explicit?.timeoutMs).toBe(3_000);
  });

  it("buildReviewerPool assembles a mixed config without throwing", () => {
    const config = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      fallbacks: [
        {
          provider: { type: "typesafe", baseUrl: "https://backup.example", apiKey: "k" },
          model: "jev-1.13",
        },
      ],
    });
    const engine = buildReviewerPool(config, {
      registry,
      modelCall: async () => llmAllow(),
    });
    expect(typeof engine.review).toBe("function");
  });

  it("keeps typesafe.timeoutMs on the Jev primary instead of the top-level one", () => {
    const config = configSchema.parse({
      provider: { type: "typesafe", baseUrl: "https://primary.example", apiKey: "k" },
      model: "jev-1.13",
      timeoutMs: 60_000,
      typesafe: { timeoutMs: 7_000 },
      fallbacks: [{ provider: "openai", model: "backup" }],
    });
    const [primary, backup] = resolvePoolEndpoints(config);
    // lane-local tuning never leaks: the primary keeps 7s, the backup
    // gets the discounted top-level default, not the Jev-local one.
    expect(primary?.timeoutMs).toBe(7_000);
    expect(backup?.timeoutMs).toBe(10_000);
  });

  it("scopes instructions per lane: string shared, object Jev-only", async () => {
    const seenSystems: string[] = [];
    const sniffingCall: ModelCallFn = async (_model, context) => {
      seenSystems.push(context.systemPrompt ?? "");
      return llmAllow();
    };
    // A string feeds both lanes: the LLM system prompt carries it.
    // Unit-pin the Jev-only overlay branch (schema rejects object
    // instructions on a string provider, so no backup walk can show it).
    const shared = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      instructions: "shared rules",
      fallbacks: [],
    });
    const overlay = configSchema.parse({
      provider: { type: "typesafe", baseUrl: "https://primary.example", apiKey: "k" },
      model: "jev-1.13",
      instructions: { background: "jev background" },
      fallbacks: [],
    });
    expect(resolveLaneInstructions(overlay)).toMatchObject({
      llm: null,
      jev: { background: "jev background" },
    });
    const { log } = recordingLog();
    await buildReviewerPool(shared, { registry, modelCall: sniffingCall }).review(reviewCtx(log));
    expect(seenSystems).toHaveLength(1);
    expect(seenSystems[0]).toContain("shared rules");
  });
});
