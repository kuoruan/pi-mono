import type { AssistantMessage, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { describe, expect, it, vi } from "vitest";

import { type AiGuardConfig, configSchema } from "#src/config-schema.ts";
import { MODEL_CALL_ERROR_EVENT } from "#src/decision-record.ts";
import {
  type CompleteSimpleFn,
  type ModelCallContext,
  createCompleteSimple,
  reviewModel,
} from "#src/model-review.ts";

const baseConfig = configSchema.parse({
  provider: "anthropic",
  model: "test-model",
  timeoutMs: 15000,
});

const fakeModel = { provider: "test", id: "test-model" } as unknown as Model<any>;

/**
 * Build a ModelCallContext with defaults from baseConfig.
 *
 * @param completeSimple - The model completer function to inject.
 * @param overrides - Optional overrides for apiKey, headers, reasoning, log, requestId.
 * @returns A `ModelCallContext` for testing.
 */
function makeContext(
  completeSimple: CompleteSimpleFn,
  overrides: {
    apiKey?: string;
    headers?: Record<string, string>;
    reasoning?: AiGuardConfig["reasoning"];
    log?: AuthorizerLog;
    requestId?: string;
  } = {},
): ModelCallContext {
  return {
    model: fakeModel,
    completeSimple,
    auth: { apiKey: overrides.apiKey, headers: overrides.headers },
    reasoning: overrides.reasoning ?? baseConfig.reasoning,
    maxTokens: baseConfig.maxTokens,
    log: overrides.log ?? { review: () => {}, debug: () => {} },
    requestId: overrides.requestId ?? "test-req",
  };
}

function makeReply(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

const timeoutCompleteSimple = async (
  _model: Model<any>,
  _ctx: Context,
  opts?: SimpleStreamOptions,
): Promise<AssistantMessage> => {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException("timeout", "TimeoutError")), 1000);
    opts?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
};

const errorCompleteSimple = async (): Promise<AssistantMessage> => {
  throw new Error("network error");
};

const nonErrorCompleteSimple = async (): Promise<AssistantMessage> => {
  throw "plain string error";
};

describe("reviewModel", () => {
  it("returns allow verdict from text reply", async () => {
    const completeSimple = async (): Promise<AssistantMessage> =>
      makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("returns deny verdict with reason", async () => {
    const completeSimple = async (): Promise<AssistantMessage> =>
      makeReply([{ type: "text", text: '{"verdict":"deny","reason":"Unsafe"}' }], "stop");
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "deny", reason: "Unsafe" });
  });

  it("falls back to text parsing when no JSON", async () => {
    const completeSimple = async (): Promise<AssistantMessage> =>
      makeReply([{ type: "text", text: '{"verdict": "allow"}' }], "stop");
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("defers when model returns empty content", async () => {
    const completeSimple = async (): Promise<AssistantMessage> => makeReply([], "stop");
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("empty-reply");
    // A fast empty reply retried and stayed empty — attempts reflects it.
    expect(result.attempts).toBe(2);
  });

  it("retries a fast empty reply and adopts the second attempt's verdict", async () => {
    const calls: { attempts: number }[] = [];
    let nth = 0;
    const completeSimple: CompleteSimpleFn = async (_model, _context, options) => {
      calls.push({ attempts: options?.maxRetries ?? 0 });
      nth++;
      return nth === 1
        ? makeReply([{ type: "thinking", thinking: "…" }], "stop")
        : makeReply([{ type: "text", text: '{"verdict":"allow"}' }], "stop");
    };
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "allow" });
    expect(result.attempts).toBe(2);
    expect(calls.length).toBe(2);
    // Attempt 1 rides pi-ai's provider retry; the empty-reply retry is
    // budgetless (maxRetries 0) — see the max-3-requests contract.
    expect(calls[0]!.attempts).toBe(1);
    expect(calls[1]!.attempts).toBe(0);
  });

  it("does not retry a slow empty reply (half-window gate)", async () => {
    let calls = 0;
    const completeSimple: CompleteSimpleFn = async () => {
      calls++;
      // Consume more than half the 100ms window before answering empty.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return makeReply([], "stop");
    };
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 100);
    expect(result.deferKind).toBe("empty-reply");
    expect(result.attempts).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("the retry's budget is the remaining window", async () => {
    let nth = 0;
    const completeSimple: CompleteSimpleFn = async (_model, _context, options) => {
      nth++;
      if (nth === 1) {
        // ~200ms of the 1000ms window — comfortably under the half-window
        // gate even on a loaded CI runner (generous margins: gate < 500,
        // abort at ~800 vs natural end at 2200).
        await new Promise((resolve) => setTimeout(resolve, 200));
        return makeReply([], "stop");
      }
      // Honor the abort signal like a real provider would: the retry's
      // budget (~800ms remaining) aborts this 2000ms sleep.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), 2000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return makeReply([{ type: "text", text: '{"verdict":"allow"}' }], "stop");
    };
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 1000);
    // The retry hit its remaining-window budget: call failed via abort →
    // timeout defer, with both attempts accounted.
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("timeout");
    expect(result.attempts).toBe(2);
  });

  it("classifies abort-resolved empty reply as timeout, not empty-reply", async () => {
    // AbortSignal.timeout() does not throw — the Anthropic provider catches
    // the abort and resolves with an empty AssistantMessage whose stopReason
    // is "aborted". This must be classified as "timeout" for telemetry.
    const completeSimple = async (): Promise<AssistantMessage> => makeReply([], "aborted");
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("timeout");
  });

  it("classifies error-resolved empty reply as call-failed, not empty-reply", async () => {
    // Provider errors (rate limits, proxy/WAF blocks) resolve as non-thrown
    // responses with stopReason "error" — infrastructure failure, not
    // model behavior. The bucket must say so: "call-failed" joins the
    // thrown path, and "empty-reply" stays reserved for genuine model
    // silence (a completed reply that chose to say nothing).
    const completeSimple = async (): Promise<AssistantMessage> => makeReply([], "error");
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("call-failed");
    // A fast error-resolved reply still retried (transient errors deserve
    // it) and stayed failed — attempts reflects both.
    expect(result.attempts).toBe(2);
  });

  it("defers on timeout", async () => {
    const ctx = makeContext(timeoutCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 50);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("timeout");
  });

  it("emits a model_call_error debug record on model call failure", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const ctx = makeContext(errorCompleteSimple, { log, requestId: "req-42" });
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("call-failed");
    const failure = debugCalls.find((c) => c.event === MODEL_CALL_ERROR_EVENT);
    expect(failure).toBeDefined();
    expect(failure!.data.requestId).toBe("req-42");
    expect(failure!.data.deferKind).toBe("call-failed");
  });

  it("handles a non-Error throw (String(e) branch)", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const ctx = makeContext(nonErrorCompleteSimple, { log });
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("call-failed");
    const failure = debugCalls.find((c) => c.event === MODEL_CALL_ERROR_EVENT);
    expect(failure).toBeDefined();
    expect(failure!.data.error).toBe("plain string error");
  });

  it("passes reasoning level when not off", async () => {
    let capturedOptions: SimpleStreamOptions | undefined;
    const completeSimple = async (
      _model: Model<any>,
      _ctx: Context,
      opts?: SimpleStreamOptions,
    ): Promise<AssistantMessage> => {
      capturedOptions = opts;
      return makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);
    };
    const ctx = makeContext(completeSimple, { reasoning: "low" });
    await reviewModel(ctx, "test", "test", 15000);
    expect(capturedOptions?.reasoning).toBe("low");
  });

  it("omits reasoning when off", async () => {
    let capturedOptions: SimpleStreamOptions | undefined;
    const completeSimple = async (
      _model: Model<any>,
      _ctx: Context,
      opts?: SimpleStreamOptions,
    ): Promise<AssistantMessage> => {
      capturedOptions = opts;
      return makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);
    };
    const ctx = makeContext(completeSimple);
    await reviewModel(ctx, "test", "test", 15000);
    expect(capturedOptions?.reasoning).toBeUndefined();
  });
});

describe("reviewModel — riskLevel passthrough", () => {
  it("passes riskLevel through from the verdict", async () => {
    const completeSimple = async (): Promise<AssistantMessage> =>
      makeReply(
        [{ type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' }],
        "stop",
      );
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "deny", reason: "unsafe" });
    expect(result.riskLevel).toBe("high");
  });

  it("leaves riskLevel undefined when omitted", async () => {
    const completeSimple = async (): Promise<AssistantMessage> =>
      makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);
    const ctx = makeContext(completeSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.riskLevel).toBeUndefined();
  });
});

describe("createCompleteSimple", () => {
  it("calls provider.streamSimple().result() when the provider is found", async () => {
    const result = vi.fn<() => AssistantMessage>(
      () => ({ ok: true }) as unknown as AssistantMessage,
    );
    const streamSimple = vi.fn<() => { result: typeof result }>(
      () => ({ result }) as unknown as never,
    );
    const provider = { streamSimple } as unknown as never;
    const getProvider = vi.fn<() => typeof provider>(() => provider);
    const registry = { getProvider } as unknown as never;
    const complete = createCompleteSimple(() => registry);
    const model = { provider: "test" } as unknown as Model<any>;
    await complete(model, {} as Context);
    expect(getProvider).toHaveBeenCalledWith("test");
    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
  });

  it("throws with the provider name when no provider is registered", async () => {
    const registry = { getProvider: () => undefined } as unknown as never;
    const complete = createCompleteSimple(() => registry);
    const model = { provider: "missing" } as unknown as Model<any>;
    await expect(complete(model, {} as Context)).rejects.toThrow(/missing/);
  });

  it("throws when registry is undefined", async () => {
    const complete = createCompleteSimple(() => undefined);
    const model = { provider: "test" } as unknown as Model<any>;
    await expect(complete(model, {} as Context)).rejects.toThrow(/provider/i);
  });
});
