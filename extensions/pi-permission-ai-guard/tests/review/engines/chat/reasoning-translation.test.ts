/**
 * Regression pin for the reasoning regression (the `complete` → `streamSimple`
 * switch): drives ai-guard's own call path through the *real* pi-ai
 * openai-completions translation and asserts the outbound request carries the
 * mapped `reasoning_effort`.
 *
 * The unit delegation test in `call.test.ts` only pins "we hand `reasoning` to
 * the registry method". That test style is exactly what let the original bug
 * through — it never observed the transport. This one does.
 *
 * Coverage boundary: `onPayload` observes the assembled request and the
 * `fetch` stub observes the provider dispatch, so the reasoning →
 * `reasoning_effort` mapping and the `signal` handed to the provider are
 * covered end-to-end. `maxRetries` is deliberately NOT asserted here (its
 * pass-through is pinned at the seam by `call.test.ts` and verified against
 * pi-ai's `buildBaseOptions`).
 *
 * No network: the `fetch` stub always throws, so a reorder that moved
 * `onPayload` after dispatch would still never hit the wire — and would fail
 * the explicit `params` capture assertion instead of silently passing.
 */

import { type Api, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { describe, expect, it } from "vitest";

import type { ChatRegistryLike } from "#src/model/model-registry.ts";
import {
  type ModelCallContext,
  createModelCall,
  reviewModel,
} from "#src/review/engines/chat/call.ts";

/**
 * A minimal openai-completions model carrying the reporter's shape: reasoning
 * on, reasoning-effort support, and a thinkingLevelMap whose `high` is null.
 *
 * @returns The model fixture.
 */
function makeModel(): Model<"openai-completions"> {
  return {
    id: "test-model",
    name: "test-model",
    provider: "test",
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: null, max: "xhigh" },
    compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
    contextWindow: 128000,
    maxTokens: 8192,
    input: ["text"],
  } as unknown as Model<"openai-completions">;
}

/**
 * Run one review through the real provider and capture the assembled request
 * params plus the abort signal the provider dispatched with.
 *
 * @param reasoning - The configured reasoning level.
 * @returns The captured outbound params and the dispatched signal.
 */
async function captureRequest(reasoning: ModelCallContext["reasoning"]) {
  const model = makeModel();
  const provider = deepseekProvider();
  let params: Record<string, unknown> | undefined;
  let signal: unknown;
  const registry: ChatRegistryLike = {
    find: () => model as unknown as Model<Api>,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
    streamSimple: (m, context, options) =>
      provider.streamSimple(
        m as unknown as Model<"openai-completions">,
        normalizeContext(context),
        {
          ...options,
          onPayload: (payload) => {
            params = payload as Record<string, unknown>;
          },
          // Network backstop: if `onPayload` ever stops being called before
          // dispatch, this still keeps the test off the wire.
          fetch: ((_url: unknown, init?: { signal?: unknown }) => {
            signal = init?.signal;
            throw new Error("network disabled in test");
          }) as unknown as typeof fetch,
        },
      ),
  };
  const ctx: ModelCallContext = {
    model: model as unknown as Model<Api>,
    modelCall: createModelCall(() => registry),
    auth: { apiKey: "k" },
    reasoning,
    maxTokens: 2048,
    log: { review: () => {}, debug: () => {} },
    requestId: "req",
  };
  await reviewModel(ctx, "sys", "user", 15000);
  if (!params) throw new Error("onPayload was never called — no outbound params captured");
  return { params, signal };
}

describe("reasoning reaches the provider (real pi-ai translation)", () => {
  it("maps the configured level to reasoning_effort", async () => {
    const { params, signal } = await captureRequest("medium");
    expect(params.reasoning_effort).toBe("medium");
    // The ai-guard abort signal reaches the provider dispatch (timeout budget).
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("clamps an unsupported level to the nearest supported one", async () => {
    // Upstream-contract pin (not the regression discriminator): `high` is null
    // in the map, so pi-ai's clampThinkingLevel walks forward to `max`, whose
    // mapped value is `xhigh` — never a silent drop to `off`.
    const { params } = await captureRequest("high");
    expect(params.reasoning_effort).toBe("xhigh");
  });

  it("maps off to the thinkingLevelMap's off value", async () => {
    // Upstream-contract pin: ai-guard omits `reasoning` entirely when off, so
    // the provider falls back to the map's own off value. (The old `complete`
    // path sent the same value, so this case does not discriminate the bug.)
    const { params } = await captureRequest("off");
    expect(params.reasoning_effort).toBe("none");
  });
});
