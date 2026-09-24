import type { AssistantMessage, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { describe, expect, it, vi } from "vitest";

import { MODEL_CALL_ERROR_EVENT } from "#src/audit/events.ts";
import { type AiGuardConfig, configSchema } from "#src/config/config-schema.ts";
import {
  type ModelCallFn,
  type ModelCallContext,
  createModelCall,
  reviewModel,
} from "#src/model/model-review.ts";

const baseConfig = configSchema.parse({
  provider: "anthropic",
  model: "test-model",
  timeoutMs: 15000,
});

const fakeModel = { provider: "test", id: "test-model" } as Model<any>;

/**
 * Build a ModelCallContext with defaults from baseConfig.
 *
 * @param modelCall - The model completer function to inject.
 * @param overrides - Optional overrides for apiKey, headers, reasoning, log, requestId.
 * @returns A `ModelCallContext` for testing.
 */
function makeContext(
  modelCall: ModelCallFn,
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
    modelCall,
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

const allowCompleteSimple = async (): Promise<AssistantMessage> =>
  makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);

const denyCompleteSimple = async (): Promise<AssistantMessage> =>
  makeReply([{ type: "text", text: '{"verdict":"deny","reason":"Unsafe"}' }], "stop");

const allowSpacedCompleteSimple = async (): Promise<AssistantMessage> =>
  makeReply([{ type: "text", text: '{"verdict": "allow"}' }], "stop");

const emptyCompleteSimple = async (): Promise<AssistantMessage> => makeReply([], "stop");

const abortedCompleteSimple = async (): Promise<AssistantMessage> => makeReply([], "aborted");

const errorResolvedCompleteSimple = async (): Promise<AssistantMessage> => makeReply([], "error");

const denyRiskyCompleteSimple = async (): Promise<AssistantMessage> =>
  makeReply(
    [{ type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' }],
    "stop",
  );

describe("reviewModel", () => {
  it("returns allow verdict from text reply", async () => {
    const ctx = makeContext(allowCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("returns deny verdict with reason", async () => {
    const ctx = makeContext(denyCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "deny", reason: "Unsafe" });
  });

  it("falls back to text parsing when no JSON", async () => {
    const ctx = makeContext(allowSpacedCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "allow" });
  });

  it("defers when model returns empty content", async () => {
    const ctx = makeContext(emptyCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "defer" });
    expect(result.deferKind).toBe("empty-reply");
    // A fast empty reply retried and stayed empty — attempts reflects it.
    expect(result.attempts).toBe(2);
  });

  it("retries a fast empty reply and adopts the second attempt's verdict", async () => {
    const calls: { attempts: number }[] = [];
    let nth = 0;
    const modelCall: ModelCallFn = async (_model, _context, options) => {
      calls.push({ attempts: options?.maxRetries ?? 0 });
      nth++;
      return nth === 1
        ? makeReply([{ type: "thinking", thinking: "…" }], "stop")
        : makeReply([{ type: "text", text: '{"verdict":"allow"}' }], "stop");
    };
    const ctx = makeContext(modelCall);
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
    const modelCall: ModelCallFn = async () => {
      calls++;
      // Consume more than half the 100ms window before answering empty.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return makeReply([], "stop");
    };
    const ctx = makeContext(modelCall);
    const result = await reviewModel(ctx, "test", "test", 100);
    expect(result.deferKind).toBe("empty-reply");
    expect(result.attempts).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("the retry's budget is the remaining window", async () => {
    let nth = 0;
    const modelCall: ModelCallFn = async (_model, _context, options) => {
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
    const ctx = makeContext(modelCall);
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
    const ctx = makeContext(abortedCompleteSimple);
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
    const ctx = makeContext(errorResolvedCompleteSimple);
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
    };
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
    };
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
    const modelCall = async (
      _model: Model<any>,
      _ctx: Context,
      opts?: SimpleStreamOptions,
    ): Promise<AssistantMessage> => {
      capturedOptions = opts;
      return makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);
    };
    const ctx = makeContext(modelCall, { reasoning: "low" });
    await reviewModel(ctx, "test", "test", 15000);
    expect(capturedOptions?.reasoning).toBe("low");
  });

  it("omits reasoning when off", async () => {
    let capturedOptions: SimpleStreamOptions | undefined;
    const modelCall = async (
      _model: Model<any>,
      _ctx: Context,
      opts?: SimpleStreamOptions,
    ): Promise<AssistantMessage> => {
      capturedOptions = opts;
      return makeReply([{ type: "text", text: '{"verdict":"allow"}' }]);
    };
    const ctx = makeContext(modelCall);
    await reviewModel(ctx, "test", "test", 15000);
    expect(capturedOptions?.reasoning).toBeUndefined();
  });
});

describe("reviewModel — riskLevel passthrough", () => {
  it("passes riskLevel through from the verdict", async () => {
    const ctx = makeContext(denyRiskyCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.verdict).toEqual({ kind: "deny", reason: "unsafe" });
    expect(result.riskLevel).toBe("high");
  });

  it("leaves riskLevel undefined when omitted", async () => {
    const ctx = makeContext(allowCompleteSimple);
    const result = await reviewModel(ctx, "test", "test", 15000);
    expect(result.riskLevel).toBeUndefined();
  });
});

describe("createModelCall", () => {
  it("delegates to registry.complete with model, context, and options", async () => {
    const reply = { ok: true } as unknown as AssistantMessage;
    const complete = vi.fn<() => Promise<AssistantMessage>>(async () => reply);
    const registry = { complete } as never;
    const run = createModelCall(() => registry);
    const model = { provider: "test" } as Model<any>;
    const context = {} as Context;
    const options = { maxTokens: 1 } as never;
    await expect(run(model, context, options)).resolves.toBe(reply);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(model, context, options);
  });

  it("throws when registry is undefined", async () => {
    const run = createModelCall(() => undefined);
    const model = { provider: "test" } as Model<any>;
    await expect(run(model, {} as Context)).rejects.toThrow(/registry/i);
  });
});
