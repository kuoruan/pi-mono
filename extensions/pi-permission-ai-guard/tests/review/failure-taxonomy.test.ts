/**
 * Failure-taxonomy direct tests: the switch/terminal matrix through the
 * module's own interface. The lane adapters rewire these same functions
 * (their seam tests carry the behavioral twins); here each matrix cell
 * pins the decision once, so a table edit that weakens failover fails
 * here first.
 *
 * Zero behavioral intent — every expectation below mirrors the table in
 * src/review/failure-taxonomy.ts.
 */

import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  availabilityReason,
  classifyFailure,
  failoverReason,
  switchableStatusReason,
} from "#src/review/failure-taxonomy.ts";

const httpError = (status: number) =>
  APIError.fromResponse(status, { error: "no capacity" }, new Headers());

describe("switchableStatusReason", () => {
  it.each([402, 404, 408, 409, 410, 425, 429, 500, 503])("switches on %i", (status) => {
    expect(switchableStatusReason(status)).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422, 451, 200, 301])("stays terminal on %i", (status) => {
    expect(switchableStatusReason(status)).toBeUndefined();
  });

  it("never switches on a non-numeric status", () => {
    expect(switchableStatusReason("429")).toBeUndefined();
    expect(switchableStatusReason(undefined)).toBeUndefined();
  });
});

describe("availabilityReason (untyped chat-lane input)", () => {
  it.each([409, 425, 429, 503])("switches on %i", (status) => {
    expect(availabilityReason(`Error: ${status} busy`)).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422])("refuses to route around %i", (status) => {
    expect(availabilityReason(`Error: ${status} denied`)).toBeUndefined();
  });

  it("lets a typed status win over a misleading body", () => {
    expect(availabilityReason(Object.assign(new Error("denied"), { status: 403 }))).toBeUndefined();
    expect(availabilityReason(Object.assign(new Error("conflict"), { status: 409 }))).toBe(
      "http-409",
    );
  });

  it("reads quota, timeout, and connection wording", () => {
    expect(availabilityReason("FreeUsageLimitError: free quota exhausted")).toBe("quota");
    expect(availabilityReason("request timed out")).toBe("timeout");
    expect(availabilityReason(new Error("socket hang up"))).toBe("connection");
  });

  it("never classifies an unknown failure as switchable", () => {
    expect(availabilityReason(new Error("unexpected parser bug"))).toBeUndefined();
  });

  it("prefers quota over connection wording (evaluation order)", () => {
    // Matches both rules; the documented order puts quota first.
    expect(availabilityReason("fetch failed: FreeUsageLimitError")).toBe("quota");
  });

  it("never routes around a refusal that also mentions quota", () => {
    // The refusal guard runs before the quota rule: a 403 mentioning an
    // exhausted quota is still the provider's refusal, not a failover.
    expect(availabilityReason("403 forbidden: quota exceeded")).toBeUndefined();
  });
});

describe("failoverReason (typed classifier-lane input)", () => {
  it.each([402, 404, 408, 409, 410, 425, 429, 503])("switches on SDK %i", (status) => {
    expect(failoverReason(httpError(status))).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422])("stays terminal on SDK %i", (status) => {
    expect(failoverReason(httpError(status))).toBeUndefined();
  });

  it("switches on timeouts and connection failures, never on user aborts", () => {
    expect(failoverReason(new APITimeoutError(5_000))).toBe("timeout");
    expect(failoverReason(new APIConnectionError("socket hang up"))).toBe("connection");
    expect(failoverReason(new APIUserAbortError())).toBeUndefined();
  });
});

describe("classifyFailure (terminal defer kind)", () => {
  it("reads timeouts off the SDK types", () => {
    expect(classifyFailure(new APITimeoutError(5_000))).toBe("timeout");
    expect(classifyFailure(new APIUserAbortError())).toBe("timeout");
  });

  it("reads a DOM timeout as a timeout", () => {
    expect(classifyFailure(new DOMException("aborted", "TimeoutError"))).toBe("timeout");
    expect(classifyFailure(new DOMException("aborted", "AbortError"))).toBe("timeout");
  });

  it("falls back to call-failed past aborts", () => {
    expect(classifyFailure(new Error("unexpected parsing bug"))).toBe("call-failed");
    expect(classifyFailure(httpError(403))).toBe("call-failed");
  });
});

describe("cross-lane agreement", () => {
  it.each([402, 404, 408, 409, 410, 425, 429, 500, 503])("both inputs switch on %i", (status) => {
    // The whole point of the unified table: the chat lane's untyped
    // string and the classifier lane's typed SDK error agree.
    expect(availabilityReason(`Error: ${status} busy`)).toBe(`http-${status}`);
    expect(failoverReason(httpError(status))).toBe(`http-${status}`);
  });

  it.each([400, 401, 403, 422])("both inputs stay terminal on %i", (status) => {
    expect(availabilityReason(`Error: ${status} denied`)).toBeUndefined();
    expect(failoverReason(httpError(status))).toBeUndefined();
  });
});
