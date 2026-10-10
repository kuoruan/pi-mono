/**
 * Cross-lane pool tests: classifier primary → chat backup and the reverse, through
 * the real adapters with faked backends. Pins that the pool loop is
 * lane-blind: failover, audit, and cacheability work across lanes.
 */

import type { AssistantMessage, ClassifierResult, Model } from "@earendil-works/pi-ai";
import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";

import { FALLBACK_EVENT, MODEL_CALL_ERROR_EVENT } from "#src/audit/events.ts";
import type { ConfigIssue } from "#src/config/config-layer.ts";
import { configSchema } from "#src/config/config-schema.ts";
import {
  buildReviewerPool,
  resolveLaneInstructions,
  resolvePoolEndpoints,
} from "#src/review/build-pool.ts";
import { createChatAdapter } from "#src/review/engines/chat/adapter.ts";
import type { ModelCallFn } from "#src/review/engines/chat/call.ts";
import { buildReviewSystemPrompt } from "#src/review/engines/chat/prompt.ts";
import { createClassifierAdapter } from "#src/review/engines/classifier/adapter.ts";
import type {
  ClassifierClientLike,
  ClassifierSystemOneResponse,
} from "#src/review/engines/classifier/client.ts";
import { DANGER_CRITERIA, DANGER_NONE } from "#src/review/engines/classifier/questions.ts";
import { createReviewerPool } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";
import { makeDetails } from "#test/fixtures.ts";
import {
  REGISTRY_API,
  REGISTRY_MODEL_ID,
  classifierReply,
  findClassifierOfType,
} from "#test/review/engines/classifier/stubs.ts";

import {
  type RecordingLogSink,
  defaultRegistry,
  fakeModel,
  makeMergedRecordingLog,
} from "./pipeline-helpers.ts";

const reviewCtx = (log: RecordingLogSink) => ({
  transcript: { trustedIntent: ["check"], toolCalls: [], strippedCount: 0 },
  request: { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" },
  log,
  requestId: "cross-lane-test",
});

function classifierAllow(): ClassifierSystemOneResponse {
  return {
    model: "classifier-test",
    usage: { input_tokens: 1, output_tokens: 0 },
    answers: {
      danger_category: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} },
      intent_match: { type: "noul", noul: 0.9 },
      risk: { type: "score", score: 0.2, confidence: 0.9, legend: {}, probabilities: {} },
    } as ClassifierSystemOneResponse["answers"],
  };
}

function chatAllow(): AssistantMessage {
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
  };
}

const httpError = (status: number) =>
  APIError.fromResponse(status, { error: "no capacity" }, new Headers());

const registry = defaultRegistry({
  find: (provider, model) => ({ ...fakeModel, provider, id: model }) as Model<any>,
});

const chatAllowCall: ModelCallFn = async () => chatAllow();

describe("cross-lane failover", () => {
  it("fails over from a classifier primary to an chat backup", async () => {
    const { events, log } = makeMergedRecordingLog();
    const engine = createReviewerPool({
      endpoints: [
        {
          lane: "classifier",
          backend: "direct",
          provider: { type: "typesafe", baseUrl: "https://primary.example", apiKey: "k" },
          model: "jev-1.13",
          timeoutMs: 5000,
          id: "typesafe/jev-1.13",
        },
        {
          lane: "chat",
          provider: "anthropic",
          model: "backup",
          timeoutMs: 5000,
          temperature: undefined,
          id: "anthropic/backup",
        },
      ],
      adapters: {
        classifier: createClassifierAdapter({
          config: {
            classifier: {
              intentThreshold: 0.5,
              riskThreshold: 0.5,
              confidenceThreshold: 0.5,
            },
            instructions: {},
          },
          createClient: () => ({
            systemOne: async () => {
              throw httpError(429);
            },
          }),
        }),
        chat: createChatAdapter({
          config: {
            reasoning: "off",
            maxTokens: 4096,
            instructions: { rules: null, replace: false },
          },
          registry,
          modelCall: chatAllowCall,
        }),
      },
    });
    const result = await engine.review(reviewCtx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("anthropic/backup (fallback 1)");
    expect(result.cacheable).toBe(false);
    // The classifier lane records the failed attempt where it is observed, so
    // it appears even though the backup then succeeds — the chat lane's catch
    // does the same, and an audit reader sees one failed attempt in both.
    expect(events.map((e) => e.event)).toEqual([MODEL_CALL_ERROR_EVENT, FALLBACK_EVENT]);
    expect(events[1]?.details).toMatchObject({ failedEndpoint: 0, reason: "http-429" });
  });

  it("fails over from an chat primary to a classifier backup", async () => {
    const { events, log } = makeMergedRecordingLog();
    const safeClassifier: ClassifierClientLike = { systemOne: async () => classifierAllow() };
    const engine = createReviewerPool({
      endpoints: [
        {
          lane: "chat",
          provider: "anthropic",
          model: "primary",
          timeoutMs: 5000,
          temperature: undefined,
          id: "anthropic/primary",
        },
        {
          lane: "classifier",
          backend: "direct",
          provider: { type: "typesafe", baseUrl: "https://backup.example", apiKey: "k" },
          model: "jev-1.13",
          timeoutMs: 5000,
          id: "typesafe/jev-1.13",
        },
      ],
      adapters: {
        chat: createChatAdapter({
          config: {
            reasoning: "off",
            maxTokens: 4096,
            instructions: { rules: null, replace: false },
          },
          registry,
          modelCall: async () => {
            throw Object.assign(new Error("busy"), { status: 503 });
          },
        }),
        classifier: createClassifierAdapter({
          config: {
            classifier: {
              intentThreshold: 0.5,
              riskThreshold: 0.5,
              confidenceThreshold: 0.5,
            },
            instructions: {},
          },
          createClient: () => safeClassifier,
        }),
      },
    });
    const result = await engine.review(reviewCtx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("allow");
    expect(result.modelId).toBe("typesafe/jev-1.13 (fallback 1)");
    expect(result.cacheable).toBe(false);
    // The chat attempt emits its call-failure debug record before the hop.
    expect(events.map((e) => e.event)).toContain(FALLBACK_EVENT);
    expect(events.find((e) => e.event === FALLBACK_EVENT)?.details).toMatchObject({
      reason: "http-503",
    });
  });

  it("discounts the fallback timeout default and honors explicit entries", () => {
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

  it("resolves a fallback's own temperature over the top-level pin", () => {
    const config = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      temperature: 0,
      fallbacks: [
        // A backup on a model that rejects non-default sampling needs its
        // own value, which is why the pin is per-entry. Omitting it inherits
        // the top-level pin rather than restoring the provider default.
        { provider: "openai", model: "implicit" },
        { provider: "openai", model: "explicit", temperature: 1 },
      ],
    });
    const resolved = resolvePoolEndpoints(config).map((endpoint) =>
      endpoint.lane === "chat" ? endpoint.temperature : "classifier",
    );
    expect(resolved).toEqual([0, 0, 1]);
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
      modelCall: async () => chatAllow(),
    });
    expect(typeof engine.review).toBe("function");
    // Assembled, not narrowed: the classifier backup survives into the pool
    // the engine walks (a dropped fallback would still leave `review` a
    // function).
    expect(resolvePoolEndpoints(config).map(({ lane, model }) => `${lane}:${model}`)).toEqual([
      "chat:primary",
      "classifier:jev-1.13",
    ]);
  });

  it("keeps the primary timeout top-level for both classifier backends", () => {
    // `classifier.timeoutMs` is gone: the primary's window is always the
    // top-level `timeoutMs`. The legacy `typesafe.timeoutMs` still parses
    // but no longer overrides anything.
    const direct = configSchema.parse({
      provider: { type: "typesafe", baseUrl: "https://primary.example", apiKey: "k" },
      model: "jev-1.13",
      timeoutMs: 60_000,
      typesafe: { timeoutMs: 7_000 },
      fallbacks: [{ provider: "openai", model: "backup" }],
    });
    const [directPrimary, directBackup] = resolvePoolEndpoints(direct);
    expect(directPrimary?.timeoutMs).toBe(60_000);
    expect(directBackup?.timeoutMs).toBe(10_000);

    // The registry classifier primary — where `classifier.timeoutMs` used
    // to be silently ignored — now reads the same top-level value.
    const registryConfig = configSchema.parse({
      provider: "typesafe",
      model: "jev-latest",
      modelType: "classifier",
      timeoutMs: 60_000,
      fallbacks: [],
    });
    const [registryPrimary] = resolvePoolEndpoints(registryConfig);
    expect(registryPrimary?.timeoutMs).toBe(60_000);
  });

  it("scopes instructions per lane: a string broadcasts, slots stay per-lane", async () => {
    const seenSystems: string[] = [];
    const sniffingCall: ModelCallFn = async (_model, context) => {
      seenSystems.push(context.systemPrompt ?? "");
      return chatAllow();
    };
    // A string is the one broadcast form: both lanes get the same content
    // (chat `rules`, classifier `background`).
    const shared = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      instructions: "shared rules",
      fallbacks: [],
    });
    expect(resolveLaneInstructions(shared)).toEqual({
      chat: { rules: "shared rules", replace: false },
      classifier: { background: "shared rules" },
    });
    // A per-lane slot feeds only its own lane; the other runs built-ins.
    const overlay = configSchema.parse({
      provider: { type: "typesafe", baseUrl: "https://primary.example", apiKey: "k" },
      model: "jev-1.13",
      instructions: { classifier: { background: "classifier background" } },
      fallbacks: [],
    });
    expect(resolveLaneInstructions(overlay)).toEqual({
      chat: { rules: null, replace: false },
      classifier: { background: "classifier background" },
    });
    const { log } = makeMergedRecordingLog();
    await buildReviewerPool(shared, { registry, modelCall: sniffingCall }).review(reviewCtx(log));
    expect(seenSystems).toHaveLength(1);
    expect(seenSystems[0]).toContain("shared rules");
  });

  it("keeps a hard-tier deny when the chat slot replaces its built-ins", async () => {
    // Replacing the chat policy must not weaken the classifier fallback: the
    // classifier slot is append-only, so its question criteria (the answer
    // contract) stay put and an always-deny category still denies.
    const config = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      fallbacks: [
        {
          provider: { type: "typesafe", baseUrl: "https://backup.example", apiKey: "k" },
          model: "jev-1.13",
        },
      ],
      instructions: {
        chat: { rules: "chat rules", replace: true },
        classifier: { background: "project background" },
      },
    });
    const { chat, classifier } = resolveLaneInstructions(config);
    expect(chat).toEqual({ rules: "chat rules", replace: true });
    expect(classifier).toEqual({ background: "project background" });

    const dangerAnswers = {
      danger_category: {
        type: "choice",
        choice: "secrets_credentials",
        confidence: 0.95,
        probabilities: {},
      },
      intent_match: { type: "noul", noul: 0.2 },
      risk: { type: "score", score: 0.95, confidence: 0.95, legend: {}, probabilities: {} },
    } as ClassifierSystemOneResponse["answers"];
    const dangerClient: ClassifierClientLike = {
      systemOne: async () => ({
        model: "classifier-test",
        usage: { input_tokens: 1, output_tokens: 0 },
        answers: dangerAnswers,
      }),
    };
    const engine = createReviewerPool({
      endpoints: [
        {
          lane: "chat",
          provider: "anthropic",
          model: "primary",
          timeoutMs: 5000,
          temperature: undefined,
          id: "anthropic/primary",
        },
        {
          lane: "classifier",
          backend: "direct",
          provider: { type: "typesafe", baseUrl: "https://backup.example", apiKey: "k" },
          model: "jev-1.13",
          timeoutMs: 5000,
          id: "typesafe/jev-1.13",
        },
      ],
      adapters: {
        chat: createChatAdapter({
          config: { reasoning: "off", maxTokens: 4096, instructions: chat },
          registry,
          modelCall: async () => {
            throw httpError(503);
          },
        }),
        classifier: createClassifierAdapter({
          config: {
            classifier: { intentThreshold: 0.5, riskThreshold: 0.5, confidenceThreshold: 0.5 },
            instructions: classifier,
          },
          createClient: () => dangerClient,
        }),
      },
    });
    const { log } = makeMergedRecordingLog();
    const result = await engine.review(reviewCtx(log));
    if (isMachineryFailure(result)) throw new Error("unexpected machinery");
    expect(result.outcome.verdict.kind).toBe("deny");
    expect(result.outcome.riskLevel).toBe("critical");
  });
});

describe("registry backend resolution", () => {
  it("routes a classifier string provider to classifier/registry", () => {
    const config = configSchema.parse({
      provider: "typesafe",
      model: "jev-latest",
      modelType: "classifier",
      fallbacks: [],
    });
    const [primary] = resolvePoolEndpoints(config);
    expect(primary).toMatchObject({
      lane: "classifier",
      backend: "registry",
      provider: "typesafe",
      model: "jev-latest",
    });
  });

  it("builds each endpoint's audit identity with the endpoint", () => {
    // The lane owns the spelling: chat and registry endpoints carry
    // `provider/model`, a direct classifier endpoint the SDK protocol
    // prefix. Built where the endpoint is built — the pool appends the walk
    // position and nothing else.
    const chatConfig = configSchema.parse({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(resolvePoolEndpoints(chatConfig).map((e) => e.id)).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);

    const directConfig = configSchema.parse({ provider: { type: "typesafe" }, model: "jev-1.13" });
    expect(resolvePoolEndpoints(directConfig).map((e) => e.id)).toEqual(["typesafe/jev-1.13"]);

    // A deliberately non-typesafe provider id: the registry spelling must
    // come from the endpoint itself, never from a hardcoded protocol prefix
    // (the bug this replaced) — `typesafe/jev-latest` would hide it, since
    // the wrong prefix and the right one spell the same string there.
    const registryConfig = configSchema.parse({
      provider: "cloudflare-workers-ai",
      model: "classify-v1",
      modelType: "classifier",
    });
    expect(resolvePoolEndpoints(registryConfig).map((e) => e.id)).toEqual([
      "cloudflare-workers-ai/classify-v1",
    ]);
  });

  it("drives a registry whose methods read `this` (pi's real shape)", async () => {
    // pi's ModelRegistry is a class: `findOfType`/`classify` read
    // `this.runtime`, so a detached reference throws TypeError. The other
    // fakes in this file are arrow functions and hide that — this one is a
    // method-style object so the bound-call path is actually exercised.
    const seen: string[] = [];
    const classStyle = {
      runtime: { id: "runtime" },
      findOfType(this: { runtime: unknown }, type: string, provider: string, model: string) {
        seen.push(`find:${String(this?.runtime !== undefined)}`);
        return type === "classifier" && provider === "typesafe"
          ? { provider, id: model }
          : undefined;
      },
      async classify(this: { runtime: unknown }, model: { id: string }) {
        seen.push(`classify:${String(this?.runtime !== undefined)}`);
        return {
          model: model.id,
          stopReason: "stop",
          answers: classifierAllow().answers,
          usage: { input_tokens: 1, output_tokens: 0 },
        };
      },
      // The signatures deviate from `ModelRegistryLike` on purpose: this pin is
      // about `this`-binding and call shape, not type conformance.
    } as never;
    const config = configSchema.parse({
      provider: "typesafe",
      model: "jev-latest",
      modelType: "classifier",
      fallbacks: [],
    });
    // Registration runs the probe (findOfType) with the receiver bound.
    const pool = buildReviewerPool(config, {
      registry: classStyle,
      modelCall: chatAllowCall,
    });
    expect(seen.some((s) => s.startsWith("find:true"))).toBe(true);

    const { log } = makeMergedRecordingLog();
    await pool.review(reviewCtx(log));
    // ...and the ask runs classify with the receiver bound.
    expect(seen.some((s) => s.startsWith("classify:true"))).toBe(true);
  });

  it("keeps object providers on classifier/direct and plain strings on chat", () => {
    const config = configSchema.parse({
      provider: { type: "typesafe", baseUrl: "https://x.ai/api", apiKey: "k" },
      model: "jev-1.13",
      fallbacks: [{ provider: "openai", model: "backup" }],
    });
    const [primary, backup] = resolvePoolEndpoints(config);
    expect(primary).toMatchObject({ lane: "classifier", backend: "direct" });
    expect(backup).toMatchObject({ lane: "chat" });
  });

  it("skips an unresolvable classifier fallback with an issue", () => {
    const config = configSchema.parse({
      provider: "anthropic",
      model: "primary",
      fallbacks: [{ provider: "typesafe", model: "gone", modelType: "classifier" }],
    });
    const skipped: Array<{ path: string; message: string }> = [];
    const endpoints = resolvePoolEndpoints(config, {
      probe: () => false,
      onSkipped: (issue) => skipped.push(issue),
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({ lane: "chat" });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.path).toBe("fallbacks.0.model");
    expect(skipped[0]!.message).toContain("not found");
  });

  it("throws on an unresolvable classifier primary", () => {
    const config = configSchema.parse({
      provider: "typesafe",
      model: "gone",
      modelType: "classifier",
      fallbacks: [],
    });
    const missingCatalog = defaultRegistry({
      classify: async () => classifierReply(),
      findOfType: findClassifierOfType(false),
    });
    expect(() =>
      buildReviewerPool(config, { registry: missingCatalog, modelCall: chatAllowCall }),
    ).toThrow(/not found in pi's model catalog/);
  });

  it("throws on old pi without classifier support", () => {
    const config = configSchema.parse({
      provider: "typesafe",
      model: "jev-latest",
      modelType: "classifier",
      fallbacks: [],
    });
    // No classify/findOfType: pre-0.99 registry shape.
    expect(() => buildReviewerPool(config, { registry, modelCall: chatAllowCall })).toThrow(
      /needs pi with classifier support/,
    );
  });

  it("skips a classifier fallback on old pi instead of failing the session", () => {
    // Same old pi, but the registry entry is a fallback: the fallback
    // contract is "a broken backup degrades", so registration succeeds
    // and the skip surfaces on the warn path.
    const config = configSchema.parse({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
    });
    const skipped: ConfigIssue[] = [];
    // Old pi: probe is undefined, so resolve keeps the registry endpoint
    // for the structural gate — which skips it (fallback, not primary)
    // onto the warn path while the chat primary survives. The full build
    // exercises the gate end to end.
    const pool = buildReviewerPool(config, {
      registry,
      modelCall: chatAllowCall,
      onSkippedFallback: (issue) => skipped.push(issue),
    });
    // ReviewerEngine exposes no endpoint list; assert the observable
    // contract — registration succeeds (no throw) and the skip warns.
    expect(pool).toBeDefined();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.path).toBe("fallbacks.0");
    expect(skipped[0]!.message).toContain("classifier support");
  });

  it("never attempts a classifier fallback the gate rejected", async () => {
    // The warn path alone is not the guarantee: a rejected endpoint must
    // be physically absent, or the walk reaches an unrunnable backend on
    // the first failover.
    const config = configSchema.parse({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
    });
    const skipped: ConfigIssue[] = [];
    // Old pi: admission carries no probe, so the classifier fallback is
    // rejected and never enters the list the pool walks.
    const endpoints = resolvePoolEndpoints(config, {
      probe: undefined,
      onSkipped: (issue) => skipped.push(issue),
    });
    expect(endpoints.map((e) => e.lane)).toEqual(["chat"]);
    expect(skipped).toHaveLength(1);

    // A failing chat primary sends the walk to the backup list; with the
    // classifier endpoint gone the walk ends on the primary's own defer
    // (fail-safe), and no classifier transport is ever contacted.
    let attempts = 0;
    const failing: ModelCallFn = async () => {
      attempts += 1;
      throw httpError(500);
    };
    const pool = buildReviewerPool(config, { registry, modelCall: failing });
    const { log } = makeMergedRecordingLog();
    const result = await pool.review(reviewCtx(log));
    expect(attempts).toBe(1);
    expect(isMachineryFailure(result)).toBe(false);
    expect(result.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("survives a catalog hot-change after a prevalidated fallback", async () => {
    // Registration proved the fallback resolves; the catalog then drops
    // it. Resolution is eager and cached, so the per-ask path reads the
    // prebuilt facade instead of re-querying the catalog.
    let present = true;
    let calls = 0;
    // `classify` returns pi-ai's classifier answers (bool/score/choice),
    // which the facade projects back to SDK noul/choice/score shapes.
    const classifyResult = {
      api: REGISTRY_API,
      provider: "typesafe",
      model: REGISTRY_MODEL_ID,
      timestamp: 0,
      stopReason: "stop",
      answers: {
        danger_category: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
        intent_match: { type: "bool", probability: 0.9 },
        risk: { type: "score", score: 0.2, confidence: 0.9 },
      },
      usage: {
        input: 3,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 4,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } satisfies ClassifierResult;
    const hotRegistry = defaultRegistry({
      classify: async () => {
        calls += 1;
        return classifyResult;
      },
      findOfType: findClassifierOfType(present),
    });
    const config = configSchema.parse({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      fallbacks: [{ provider: "typesafe", model: "jev-latest", modelType: "classifier" }],
    });
    const pool = buildReviewerPool(config, {
      registry: hotRegistry,
      // The chat primary must fail, or the walk never reaches the
      // fallback whose catalog entry vanished.
      modelCall: async () => {
        throw httpError(500);
      },
    });
    // The model vanishes after registration — the primary degrades to a
    // walk the surviving fallback still answers.
    present = false;
    const { log } = makeMergedRecordingLog();
    const result = await pool.review(reviewCtx(log));
    // classify was attempted against the prebuilt facade — no wiring throw,
    // and a real verdict flowed back through the translation path.
    expect(calls).toBe(1);
    if (isMachineryFailure(result)) throw new Error(`machinery: ${result.kind}`);
    expect(result.outcome.verdict.kind).toBe("allow");
  });
});

describe("lane parity", () => {
  it("offers the same number of always-deny categories in both lanes", () => {
    const alwaysDeny =
      buildReviewSystemPrompt({ rules: null, replace: false })
        .split("\n## ")
        .find((block) => block.startsWith("DENY — Always")) ?? "";
    const chatCategories = alwaysDeny.split("\n").filter((line) => line.startsWith("- **")).length;
    const classifierCategories = Object.keys(DANGER_CRITERIA).filter(
      (key) => key !== DANGER_NONE,
    ).length;
    expect(chatCategories).toBe(classifierCategories);
  });
});
