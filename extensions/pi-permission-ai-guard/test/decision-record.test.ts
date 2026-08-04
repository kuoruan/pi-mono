import type { PermissionCheckResult, PermissionState } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import {
  type DecisionBase,
  type DecisionRecord as DecisionRecordType,
  DecisionRecord,
  modelReply,
  shortCircuit,
} from "#src/decision-record.ts";

const base: DecisionBase = { requestId: "req-1", surface: "bash", target: "ls -la" };

/** The shared fields every decision record must carry. */
const SHARED_FIELDS = ["requestId", "surface", "target", "gate", "modelCalled", "verdict"] as const;

/** A valid origin value (RuleOrigin is not exported, so use the indexed type). */
const ORIGIN: PermissionCheckResult["origin"] = "builtin";

/** All six gate constructors, exercised once with representative inputs. */
const allGates: Array<{ name: string; record: DecisionRecordType }> = [
  {
    name: "policyDecided",
    record: DecisionRecord.policyDecided(base, {
      state: "allow" as PermissionState,
      origin: ORIGIN,
      matchedPattern: "ls *",
    }),
  },
  { name: "breaker", record: DecisionRecord.breaker(base, "deny") },
  { name: "modelUnresolved", record: DecisionRecord.modelUnresolved(base, "anthropic/test") },
  { name: "authFailed", record: DecisionRecord.authFailed(base, "anthropic/test", "no key") },
  { name: "cacheHit", record: DecisionRecord.cacheHit(base, "allow") },
  {
    name: "model",
    record: DecisionRecord.model(base, "anthropic/test", 3, {
      verdict: { kind: "deny", reason: "unsafe" },
      latencyMs: 42,
      deferReason: undefined,
      riskLevel: "high",
      rawReply: '{"verdict":"deny"}',
    }),
  },
];

describe("DecisionRecord — shared schema (property test)", () => {
  for (const { name, record } of allGates) {
    it(`${name} carries all shared fields`, () => {
      for (const field of SHARED_FIELDS) {
        expect(record, `${name} missing ${field}`).toHaveProperty(field);
      }
      expect(record.requestId).toBe("req-1");
      expect(record.surface).toBe("bash");
      expect(record.target).toBe("ls -la");
      expect(typeof record.gate).toBe("string");
      expect(typeof record.modelCalled).toBe("boolean");
      expect(["allow", "deny", "defer"]).toContain(record.verdict);
    });
  }
});

describe("DecisionRecord — per-gate shape", () => {
  it("policyDecided derives deferReason from policyState", () => {
    const r = DecisionRecord.policyDecided(base, {
      state: "deny",
      origin: ORIGIN,
      matchedPattern: null,
    });
    expect(r.gate).toBe("policy-decided");
    expect(r.modelCalled).toBe(false);
    expect(r.verdict).toBe("defer");
    expect(r.policyState).toBe("deny");
    expect(r.policyOrigin).toBe(ORIGIN);
    expect(r.matchedPattern).toBe(null);
    expect(r.deferReason).toBe("policy-deny"); // derived, not passed
  });

  it("breaker records the breaker's configured verdict (deny or defer)", () => {
    expect(DecisionRecord.breaker(base, "deny").verdict).toBe("deny");
    expect(DecisionRecord.breaker(base, "defer").verdict).toBe("defer");
    expect(DecisionRecord.breaker(base, "deny").gate).toBe("circuit-breaker");
    expect(DecisionRecord.breaker(base, "deny").modelCalled).toBe(false);
  });

  it("modelUnresolved carries modelId + deferReason", () => {
    const r = DecisionRecord.modelUnresolved(base, "anthropic/haiku");
    expect(r.gate).toBe("model-unresolved");
    expect(r.modelId).toBe("anthropic/haiku");
    expect(r.deferReason).toBe("model-unresolved");
  });

  it("authFailed carries modelId + error + deferReason", () => {
    const r = DecisionRecord.authFailed(base, "anthropic/haiku", "network down");
    expect(r.gate).toBe("auth-failed");
    expect(r.modelId).toBe("anthropic/haiku");
    expect(r.error).toBe("network down");
    expect(r.deferReason).toBe("auth-failed");
  });

  it("cacheHit records the cached verdict kind", () => {
    const r = DecisionRecord.cacheHit(base, "deny");
    expect(r.gate).toBe("cache-hit");
    expect(r.verdict).toBe("deny");
    expect(r.cachedVerdict).toBe("deny");
    expect(r.modelCalled).toBe(false);
  });

  it("model attaches rawReply for any defer path that has one", () => {
    // no-json → rawReply attached
    const noJson = DecisionRecord.model(base, "anthropic/haiku", 2, {
      verdict: { kind: "defer" },
      latencyMs: 10,
      deferReason: "no-json",
      rawReply: "garbage",
    });
    expect(noJson.gate).toBe("model");
    expect(noJson.modelCalled).toBe(true);
    expect(noJson.rawReply).toBe("garbage");

    // invalid-verdict-value (JSON parsed but verdict illegal) → rawReply attached
    const invalid = DecisionRecord.model(base, "anthropic/haiku", 2, {
      verdict: { kind: "defer" },
      latencyMs: 10,
      deferReason: "invalid-verdict-value",
      rawReply: '{"verdict":"maybe"}',
    });
    expect(invalid.rawReply).toBe('{"verdict":"maybe"}');

    // clean verdict → rawReply is a sentinel (NOT null, to distinguish from
    // the throw-based absence) — the parsed JSON is already in structured fields
    const clean = DecisionRecord.model(base, "anthropic/haiku", 2, {
      verdict: { kind: "allow" },
      latencyMs: 10,
      rawReply: '{"verdict":"allow"}',
    });
    expect(clean.rawReply).toBe("(clean verdict, rawReply omitted)");
    expect(clean.riskLevel).toBe(null);
    expect(clean.deferReason).toBe(null);

    // clean deny → same sentinel as clean allow
    const cleanDeny = DecisionRecord.model(base, "anthropic/haiku", 2, {
      verdict: { kind: "deny", reason: "unsafe" },
      latencyMs: 10,
      rawReply: '{"verdict":"deny"}',
    });
    expect(cleanDeny.rawReply).toBe("(clean verdict, rawReply omitted)");

    // throw-based defer (timeout) → no rawReply on outcome → null (genuine
    // absence, distinct from the clean-verdict sentinel)
    const timeout = DecisionRecord.model(base, "anthropic/haiku", 2, {
      verdict: { kind: "defer" },
      latencyMs: 10,
      deferReason: "timeout",
    });
    expect(timeout.rawReply).toBe(null);
  });

  it("model passes through riskLevel + latencyMs + strippedCount", () => {
    const r = DecisionRecord.model(base, "anthropic/haiku", 5, {
      verdict: { kind: "deny", reason: "unsafe" },
      latencyMs: 250,
      deferReason: undefined,
      riskLevel: "critical",
    });
    expect(r.latencyMs).toBe(250);
    expect(r.strippedCount).toBe(5);
    expect(r.riskLevel).toBe("critical");
    expect(r.verdict).toBe("deny");
    expect(r.deferReason).toBe(null); // undefined → null
  });
});

describe("DecisionRecord — debug helpers", () => {
  it("shortCircuit builds a short-circuit debug record", () => {
    const r = shortCircuit("req-1", "bash", "no-target");
    expect(r.requestId).toBe("req-1");
    expect(r.surface).toBe("bash");
    expect(r.reason).toBe("no-target");
  });

  it("shortCircuit accepts extra fields", () => {
    const r = shortCircuit("req-1", "bash", "transcript-error", { error: "boom" });
    expect(r.error).toBe("boom");
  });

  it("modelReply builds a model-reply debug record", () => {
    const r = modelReply("req-1", "anthropic/haiku", "raw text");
    expect(r.modelId).toBe("anthropic/haiku");
    expect(r.rawReply).toBe("raw text");
  });
});
