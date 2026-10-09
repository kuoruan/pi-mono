import { getEventListeners } from "node:events";

import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { APIConnectionError, APIError, APITimeoutError } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { buildClassifierRequest } from "#src/review/engines/classifier/client.ts";
import {
  classifierError,
  flattenEntry,
  toClassifierContext,
  toSystemOneAnswers,
} from "#src/review/engines/classifier/registry-client.ts";
import { failoverReason } from "#src/review/failure-taxonomy.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { makeDetails } from "#test/fixtures.ts";

import {
  REGISTRY_MODEL_ID,
  type RegistryClassify,
  classifierReply,
  errorClassifierReply,
  registryFacade,
} from "./stubs.ts";

const transcript = { trustedIntent: ["check"], toolCalls: [], strippedCount: 0 };
const request = { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" };

describe("flattenEntry", () => {
  it("passes strings through", () => {
    expect(flattenEntry("q")).toBe("q");
  });

  it("serializes structured context instead of dropping it", () => {
    const out = flattenEntry({ question: "q", context: { k: "v" } });
    expect(out).toContain("q");
    expect(out).toContain(JSON.stringify({ k: "v" }));
  });
});

describe("toClassifierContext", () => {
  it("maps noul to bool and keeps choice/score shapes", () => {
    const built = buildClassifierRequest(transcript, request, {}, REGISTRY_MODEL_ID);
    const ctx = toClassifierContext(built);
    expect(ctx.questions.danger_category?.type).toBe("choice");
    expect(ctx.questions.intent_match?.type).toBe("bool");
    expect(ctx.questions.risk?.type).toBe("score");
    // The flattened instructions carry the question text (plus the built-in
    // background), and the criteria survive the noul→bool projection as text.
    expect(ctx.questions.intent_match?.instructions).toContain(
      "The authorization anchor authorizes this action.",
    );
    expect(ctx.questions.intent_match?.criteria).toEqual({
      true: expect.stringMatching(/\S/),
      false: expect.stringMatching(/\S/),
    });
  });
});

describe("toSystemOneAnswers", () => {
  it("projects bool probability back to noul", () => {
    const answers = toSystemOneAnswers({
      danger_category: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
      intent_match: { type: "bool", probability: 0.8 },
      risk: { type: "score", score: 1, confidence: 0.7 },
    });
    expect(answers.intent_match).toMatchObject({ type: "noul", noul: 0.8 });
    expect(answers.danger_category).toMatchObject({ choice: "none" });
  });

  it("throws a connection error on mistyped answers", () => {
    expect(() =>
      toSystemOneAnswers({
        danger_category: { type: "choice", choice: "none", confidence: 1, probabilities: {} },
        intent_match: { type: "choice", choice: "x", confidence: 1, probabilities: {} },
        risk: { type: "score", score: 1, confidence: 1 },
      } as unknown as Record<string, ClassifierAnswer>),
    ).toThrow(APIConnectionError);
  });
});

describe("classifierError", () => {
  it("parses the status into an APIError", () => {
    const err = classifierError("System One API error (429): busy");
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(429);
  });

  it("maps timeout wording to APITimeoutError", () => {
    expect(classifierError("request timed out")).toBeInstanceOf(APITimeoutError);
  });

  it("falls back to a connection error", () => {
    expect(classifierError("No API key for provider")).toBeInstanceOf(APIConnectionError);
  });

  it("reads a status before timeout wording, so a refusal stays terminal", () => {
    // The message carries both signals. Status-first is the shared rule, so
    // this is the provider's refusal — never a switchable timeout that routes
    // the ask around it to another backend.
    const err = classifierError("System One API error (403): request aborted by upstream policy");
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(403);
    expect(failoverReason(err)).toBeUndefined();
  });
});

describe("createRegistryClassifierClient", () => {
  // The facade consumes the request the adapter built (same state and
  // questions the direct backend sends) — one truth source, no rebuild.
  const built = buildClassifierRequest(transcript, request, {}, REGISTRY_MODEL_ID);

  it("translates timeout/retry options and projects the response", async () => {
    const reply = classifierReply();
    const classify = vi.fn<RegistryClassify>(async () => reply);
    const response = await registryFacade(classify).systemOne(built, {
      timeout: 5_000,
      retry: { maxRetries: 0 },
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 5_000, maxRetries: 0 });
    expect(response.answers.intent_match).toMatchObject({ type: "noul", noul: 0.8 });
    expect(response.usage).toMatchObject({ input_tokens: 3, output_tokens: 1 });
  });

  it("abandons the classify call when the walk budget signal fires", async () => {
    // pi's classify takes no signal: the remaining budget is enforced by
    // abandoning the call, whose answer can no longer affect the walk.
    const classify = vi.fn<RegistryClassify>(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = registryFacade(classify).systemOne(built, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("rejects without calling the backend when the budget is already spent", async () => {
    const classify = vi.fn<RegistryClassify>(async () => classifierReply());
    await expect(
      registryFacade(classify).systemOne(built, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(APITimeoutError);
    expect(classify).not.toHaveBeenCalled();
  });

  it("forwards the walk budget signal into the request too", async () => {
    // pi-ai forwards the signal to the provider; the race is what covers a
    // version that ignores it, not a substitute for passing it.
    const classify = vi.fn<RegistryClassify>(async () => classifierReply());
    const controller = new AbortController();
    await registryFacade(classify).systemOne(built, { signal: controller.signal });
    expect(classify.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it("drops the abort listener when the classify call throws synchronously", async () => {
    // A synchronous throw (context mapping, auth lookup) must not leave a
    // listener behind on a signal that can outlive the attempt.
    const classify = vi.fn<RegistryClassify>(() => {
      throw new Error("sync boom");
    });
    const controller = new AbortController();
    await expect(
      registryFacade(classify).systemOne(built, { signal: controller.signal }),
    ).rejects.toThrow("sync boom");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("throws a classified error when stopReason is error", async () => {
    const reply = errorClassifierReply("System One API error (429): busy");
    const classify = vi.fn<RegistryClassify>(async () => reply);
    await expect(registryFacade(classify).systemOne(built)).rejects.toBeInstanceOf(APIError);
  });

  it("treats an aborted stop as a failure, not an answer", async () => {
    // pi returns `stopReason: "aborted"` with whatever answers it collected
    // before the cut. A cut-short call is not a verdict — synthesizing one
    // here would let a half-run review authorize the ask.
    const classify = vi.fn<RegistryClassify>(async () =>
      classifierReply({ stopReason: "aborted" }),
    );
    await expect(registryFacade(classify).systemOne(built)).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("classifies a status-bearing aborted stop by its status", async () => {
    // A cut-short reply can still carry the provider's status. Routing it as a
    // timeout would let failover walk around a refusal.
    const reply = classifierReply({
      stopReason: "aborted",
      errorMessage: "System One API error (403): request aborted by upstream policy",
    });
    const thrown = await registryFacade(vi.fn<RegistryClassify>(async () => reply))
      .systemOne(built)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).status).toBe(403);
    expect(failoverReason(thrown)).toBeUndefined();
  });

  it("falls back to a retryable connection error when the reply carries no message", async () => {
    // pi's classifier stop reasons are `stop`/`error`/`aborted`; an `error`
    // one is allowed to arrive without a message, and it is still a failure
    // (a killed request, not a refusal with a status).
    const reply = classifierReply({ stopReason: "error", answers: {}, errorMessage: undefined });
    const thrown = await registryFacade(vi.fn<RegistryClassify>(async () => reply))
      .systemOne(built)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(APIConnectionError);
    expect(failoverReason(thrown)).toBe("connection");
  });

  it("reports zero usage when the backend omits it", async () => {
    const classify = vi.fn<RegistryClassify>(async () => classifierReply({ usage: undefined }));
    const response = await registryFacade(classify).systemOne(built);
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
