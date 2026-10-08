/**
 * Backend-equivalence tests for the classifier lane: the same failure must
 * fail over identically whether it arrives as a direct-backend SDK error
 * or as a registry backend's `stopReason: "error"` reply.
 *
 * Why this file exists: the registry facade reconstructs an SDK error
 * from the classifier's error message so the adapter's failover
 * classification works unchanged. That makes the reconstruction a
 * load-bearing part of the failover path — and equivalence is a property
 * of the whole chain (facade → failure taxonomy → adapter), so it is
 * pinned here, through the `LaneAdapter.attempt` seam, rather than by
 * unit-testing each translator. Where the backends genuinely disagree
 * (unclassifiable registry failures), the test names the asymmetry
 * instead of hiding it.
 */

import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";

import { createClassifierAdapter } from "#src/review/engines/classifier/adapter.ts";
import type { ClassifierClientLike } from "#src/review/engines/classifier/client.ts";
import type { AttemptSpec, ClassifierPoolEndpoint } from "#src/review/pool.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import { makeDetails } from "#test/fixtures.ts";

import { errorClassifierReply, registryFacade } from "./stubs.ts";

const spec: AttemptSpec = { hasFailover: true, timeoutMs: 5_000 };

function attemptContext() {
  return {
    transcript: { trustedIntent: ["inspect files"], toolCalls: [], strippedCount: 0 },
    request: { ask: buildAskContext(makeDetails({ value: "ls" }), "/project"), target: "ls" },
    log: { review: () => {}, debug: () => {} },
    requestId: "backend-equivalence",
  };
}

const registryEndpoint: ClassifierPoolEndpoint = {
  lane: "classifier",
  backend: "registry",
  provider: "typesafe",
  model: "jev-latest",
  timeoutMs: 5_000,
  id: "typesafe/jev-latest",
};

const directEndpoint: ClassifierPoolEndpoint = {
  lane: "classifier",
  backend: "direct",
  provider: { type: "typesafe", baseUrl: "https://x.example", apiKey: "k" },
  model: "jev-1.13",
  timeoutMs: 5_000,
  id: "typesafe/jev-1.13",
};

/**
 * A registry facade whose classify reply carries the given error message.
 *
 * @param errorMessage - The error text the pi-ai reply carries.
 * @returns The facade client the registry endpoint attempts through.
 */
function errorFacade(errorMessage: string): ClassifierClientLike {
  return registryFacade(async () => errorClassifierReply(errorMessage));
}
/**
 * One adapter serving both backends: the registry endpoint through the
 * given facade, the direct endpoint through a client that throws
 * `directError`.
 *
 * @param facade - The registry client the registry endpoint attempts through.
 * @param directError - The error the direct endpoint's client throws.
 * @returns An adapter able to attempt either backend.
 */
function adapterFor(facade: ClassifierClientLike, directError: Error) {
  return createClassifierAdapter({
    config: {
      classifier: { intentThreshold: 0.5, riskThreshold: 0.5, confidenceThreshold: 0.5 },
      instructions: {},
    },
    registryClient: () => facade,
    createClient: () => ({
      systemOne: async () => {
        throw directError;
      },
    }),
  });
}

const httpError = (status: number) =>
  APIError.fromResponse(status, { error: "no capacity" }, new Headers());

describe("classifier backend equivalence", () => {
  it.each([402, 408, 409, 425, 429, 503])(
    "HTTP %i fails over identically through the registry facade and the direct SDK",
    async (status) => {
      const adapter = adapterFor(
        errorFacade(`System One API error (${status}): busy`),
        httpError(status),
      );
      const viaRegistry = await adapter.attempt(registryEndpoint, attemptContext(), spec);
      const viaDirect = await adapter.attempt(directEndpoint, attemptContext(), spec);

      expect(viaRegistry.kind).toBe("retryable");
      expect(viaDirect.kind).toBe("retryable");
      if (viaRegistry.kind !== "retryable" || viaDirect.kind !== "retryable") return;
      // The asymmetry that would matter: one backend routing around a
      // failure the other accepts as terminal.
      expect(viaDirect.reason).toBe(viaRegistry.reason);
      expect(viaRegistry.reason).toBe(`http-${status}`);
    },
  );

  it.each([400, 401, 403, 422])(
    "HTTP %i stays terminal through both backends (never routes around a refusal)",
    async (status) => {
      const adapter = adapterFor(
        errorFacade(`System One API error (${status}): denied`),
        httpError(status),
      );
      const viaRegistry = await adapter.attempt(registryEndpoint, attemptContext(), spec);
      const viaDirect = await adapter.attempt(directEndpoint, attemptContext(), spec);

      expect(viaRegistry.kind).toBe("terminal");
      expect(viaDirect.kind).toBe("terminal");
      if (viaRegistry.kind !== "terminal" || viaDirect.kind !== "terminal") return;
      expect(viaRegistry.result).toMatchObject({
        outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
      });
      expect(viaDirect.result).toMatchObject({
        outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
      });
    },
  );

  it("literal `timeout` wording fails over identically through both backends", async () => {
    // The shared case: wording both layers recognize (the facade's
    // timeout rule and `classifyAbortish`). Pin them together so the
    // reconstruction and the fallback cannot diverge.
    const adapter = adapterFor(errorFacade("request timeout"), new Error("request timeout"));
    const viaRegistry = await adapter.attempt(registryEndpoint, attemptContext(), spec);
    const viaDirect = await adapter.attempt(directEndpoint, attemptContext(), spec);
    expect(viaRegistry.kind).toBe("retryable");
    expect(viaDirect.kind).toBe("retryable");
    if (viaRegistry.kind !== "retryable" || viaDirect.kind !== "retryable") return;
    expect(viaDirect.reason).toBe(viaRegistry.reason);
    expect(viaRegistry.reason).toBe("timeout");
  });

  it("records the second asymmetry: `timed out` wording fails over via the facade only", async () => {
    // Two different timeout regexes meet here. The facade's
    // `classifierError` matches /timed out|timeout|aborted/, so
    // "request timed out" reconstructs an APITimeoutError and switches;
    // `classifyAbortish` matches only /timeout|abort/, so the same text
    // from a direct client stays terminal. In practice the direct SDK
    // throws a typed APITimeoutError, so this needs a generic Error to
    // surface — and terminal is the fail-safe direction (defer to the
    // operator instead of routing around). Pinned so the gap is a known
    // difference rather than an accident.
    const adapter = adapterFor(errorFacade("request timed out"), new Error("request timed out"));
    const viaRegistry = await adapter.attempt(registryEndpoint, attemptContext(), spec);
    const viaDirect = await adapter.attempt(directEndpoint, attemptContext(), spec);
    expect(viaRegistry.kind).toBe("retryable");
    expect(viaDirect.kind).toBe("terminal");
    if (viaRegistry.kind !== "retryable" || viaDirect.kind !== "terminal") return;
    expect(viaRegistry.reason).toBe("timeout");
    expect(viaDirect.result).toMatchObject({
      outcome: { verdict: { kind: "defer" }, deferKind: "call-failed" },
    });
  });

  it("records the one asymmetry: an unclassifiable registry failure is retryable, not terminal", async () => {
    // A status-less, timeout-less message makes the facade fall back to
    // `APIConnectionError`, which the taxonomy reads as switchable; the
    // same message thrown by a direct client stays terminal. Failover is
    // fail-safe (the backup decides), so this is a live asymmetry rather
    // than a defect — pinned here so it is a known, reviewed difference
    // instead of a surprise. Changing it changes failover behavior.
    const adapter = adapterFor(errorFacade("provider exploded"), new Error("provider exploded"));
    const viaRegistry = await adapter.attempt(registryEndpoint, attemptContext(), spec);
    const viaDirect = await adapter.attempt(directEndpoint, attemptContext(), spec);
    expect(viaRegistry.kind).toBe("retryable");
    expect(viaDirect.kind).toBe("terminal");
    if (viaRegistry.kind !== "retryable") return;
    expect(viaRegistry.reason).toBe("connection");
  });
});
