import { describe, expect, it, vi } from "vitest";

import {
  type TypesafeClientLike,
  type TypesafeSystemOneResponse,
} from "#src/review/engines/jev/client.ts";
import { createJevEngine, type JevEngineDeps } from "#src/review/engines/jev/engine.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";
import { isMachineryFailure } from "#src/review/reviewer-engine.ts";
import { makeDetails } from "#test/fixtures.ts";

function transcript(): StrippedTranscript {
  return {
    trustedIntent: ["clean up temp files"],
    toolCalls: [],
    strippedCount: 0,
  } as StrippedTranscript;
}

function noLog() {
  return { review: () => {}, debug: () => {} } as never;
}

function deps(client: TypesafeClientLike): JevEngineDeps {
  return {
    config: {
      provider: { type: "typesafe" as const },
      model: "jev-1.13",
      typesafe: { intentThreshold: 0.5, riskThreshold: 0.5, confidenceThreshold: 0.6 },
      timeoutMs: 15000,
      instructions: null,
    } as never,
    client,
    now: () => 1000,
  };
}

function answers(overrides = {}) {
  return {
    danger_category: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} },
    intent_match: { type: "noul", noul: 0.9 },
    risk: { type: "score", score: 0.4, confidence: 0.9, legend: {}, probabilities: {} },
    ...overrides,
  };
}

describe("createJevEngine", () => {
  it("allows on safe answers and reports the typesafe model id", async () => {
    const client: TypesafeClientLike = {
      systemOne: async () => ({
        model: "jev-test",
        answers: answers() as unknown as TypesafeSystemOneResponse["answers"],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    };
    const engine = createJevEngine(deps(client));
    const result = await engine.review({
      transcript: transcript(),
      request: {
        ask: buildAskContext(makeDetails({ value: "ls" }), "/project"),
        target: "ls",
      },
      log: noLog(),
      requestId: "r1",
    });
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict).toEqual({ kind: "allow" });
    expect(result.modelId).toBe("typesafe/jev-1.13");
  });

  it("denies on a danger hit", async () => {
    const client: TypesafeClientLike = {
      systemOne: async () => ({
        model: "jev-test",
        answers: answers({
          danger_category: {
            type: "choice",
            choice: "irreversible_destruction",
            confidence: 0.9,
            probabilities: {},
          },
        }) as unknown as TypesafeSystemOneResponse["answers"],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    };
    const engine = createJevEngine(deps(client));
    const result = await engine.review({
      transcript: transcript(),
      request: {
        ask: buildAskContext(makeDetails({ value: "rm -rf /" }), "/project"),
        target: "rm -rf /",
      },
      log: noLog(),
      requestId: "r2",
    });
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict.kind).toBe("deny");
    expect(result.outcome.riskLevel).toBe("critical");
  });

  it("defers call-failed when the client throws", async () => {
    const debug = vi.fn<() => void>();
    const client: TypesafeClientLike = {
      systemOne: async () => {
        throw new Error("401 Unauthorized");
      },
    };
    const engine = createJevEngine(deps(client));
    const result = await engine.review({
      transcript: transcript(),
      request: {
        ask: buildAskContext(makeDetails({ value: "ls" }), "/project"),
        target: "ls",
      },
      log: { review: () => {}, debug } as never,
      requestId: "r3",
    });
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.verdict).toEqual({ kind: "defer" });
    expect(result.outcome.deferKind).toBe("call-failed");
    expect(debug).toHaveBeenCalledOnce();
  });

  it("defers timeout on an abort error", async () => {
    const client: TypesafeClientLike = {
      systemOne: async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      },
    };
    const engine = createJevEngine(deps(client));
    const result = await engine.review({
      transcript: transcript(),
      request: {
        ask: buildAskContext(makeDetails({ value: "ls" }), "/project"),
        target: "ls",
      },
      log: noLog(),
      requestId: "r4",
    });
    expect(isMachineryFailure(result)).toBe(false);
    if (isMachineryFailure(result)) return;
    expect(result.outcome.deferKind).toBe("timeout");
  });
});
