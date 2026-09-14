/**
 * Core review-pipeline tests: the guard clauses (engine parity, auth,
 * model resolution), the verdict surface (allow/deny/defer, audit
 * records), the deny history feeding the /ai-guard denied panel, and the
 * transcript-stripping seam. Mode semantics live in
 * review-pipeline-mode.test.ts; the breaker and cache in
 * review-pipeline-devices.test.ts.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { DECISION_EVENT, MODEL_REPLY_EVENT } from "#src/audit/decision-record.ts";
import { createReviewPipeline, type DenyRecord } from "#src/review/review-pipeline.ts";
import { withAgentInstruction } from "#src/review/verdict-mode.ts";
import { makeDetails } from "#test/fixtures.ts";

import {
  baseConfig,
  makeFakeCompleteSimple,
  makeSessionManagerWith,
  makeQuery,
  makeRecordingQuery,
  noLog,
  makeRecordingLog,
  makeNotifySpy,
  expectVerdict,
  defaultRegistry,
  makePipeline,
} from "./pipeline-helpers.ts";

describe("createReviewPipeline — guard clauses", () => {
  // Surface matching and target extraction are tested directly in
  // ask.test.ts (pure function, no model stack needed).

  it("defers without a model call when policy already allows", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: async () => {
          modelCalled = true;
          return {} as AssistantMessage;
        },
      }),
    );
    await expectVerdict(authorize, { value: "ls -la" }, { kind: "defer" }, "allow");
    expect(modelCalled).toBe(false);
  });

  it("defers without a model call when policy already denies", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: async () => {
          modelCalled = true;
          return {} as AssistantMessage;
        },
      }),
    );
    await expectVerdict(authorize, { value: "cat .env" }, { kind: "defer" }, "deny");
    expect(modelCalled).toBe(false);
  });

  it("queries the deterministic engine at gate parity", async () => {
    const { query, calls } = makeRecordingQuery("ask");
    const authorize = createReviewPipeline(makePipeline());
    await authorize(makeDetails({ value: "npm test", agentName: "my-agent" }), query, noLog);
    expect(calls).toEqual([{ surface: "bash", value: "npm test", agentName: "my-agent" }]);
  });

  it("defers when model is not found in registry", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({ find: () => undefined }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when auth fails", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when getApiKeyAndHeaders throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => {
            throw new Error("network error");
          },
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when getApiKeyAndHeaders throws a non-Error value", async () => {
    // A thrown string/object (not an Error instance) must still normalize
    // to an auth-failed defer via the String(e) branch.
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => {
            throw "string error";
          },
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when stripTranscript throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        sessionManager: {
          getSessionId: () => "s1",
          buildContextEntries: () => {
            throw new Error("corrupt session");
          },
        },
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("sanitizes auth error in the audit record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => {
            throw new Error(
              "Invalid API key: sk-ant-api03-1234567890abcdefABCDEF1234567890abcdefABCDEF",
            );
          },
        }),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const authFailed = reviewCalls.find(
      (c) => c.event === DECISION_EVENT && c.data.gate === "auth-failed",
    );
    expect(authFailed).toBeDefined();
    expect(authFailed!.data.error).not.toContain(
      "sk-ant-api03-1234567890abcdefABCDEF1234567890abcdefABCDEF",
    );
    expect(authFailed!.data.error).toContain("[REDACTED]");
  });
});

describe("createReviewPipeline — verdicts", () => {
  it("returns allow when model allows", async () => {
    const authorize = createReviewPipeline(makePipeline());
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("returns deny with reason when model denies", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
  });

  it("persists deny reason in the ai_guard.decision audit record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe command"}' },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision).toBeDefined();
    expect(decision!.data.verdict).toBe("deny");
    expect(decision!.data.reason).toBe("unsafe command");
  });

  it("defers on model defer verdict", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
        notify,
      }),
    );
    await expectVerdict(authorize, { value: "ambiguous-cmd" }, { kind: "defer" });
    // A terse model defer without a reason is the model's own verdict, not
    // machinery — no cause-notice and no clarification to mirror (H1 pin).
    expect(notifications).toEqual([]);
  });

  it("defers when model returns no tool call", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "I cannot decide" }]),
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("defers when model returns empty content, logs diagnostic event", async () => {
    // Empty content → reviewModel returns a defer with deferKind
    // "empty-reply". A diagnostic event (stopReason/contentTypes) is logged
    // via MODEL_REPLY_EVENT so the operator can investigate the cause.
    const debugCalls: { event: string }[] = [];
    const log = {
      review: () => {},
      debug: (e: string) => debugCalls.push({ event: e }),
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({ completeSimple: makeFakeCompleteSimple([]) }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "defer" });
    // Empty content → diagnostic event is logged via MODEL_REPLY_EVENT
    expect(debugCalls.some((c) => c.event === MODEL_REPLY_EVENT)).toBe(true);
  });

  it("falls back to text parsing when model emits prose", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: 'My verdict: {"verdict": "allow"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("carries the review diagnostic (stopReason/rawStopReason/contentTypes/errorMessage) in the decision record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: async () =>
          ({
            role: "assistant",
            content: [],
            stopReason: "aborted",
            rawStopReason: "max_tokens",
            errorMessage: "provider hiccup",
          }) as unknown as AssistantMessage,
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.findLast((c) => c.event === DECISION_EVENT)!.data;
    expect(record.deferKind).toBe("timeout"); // aborted → timeout, not empty-reply
    expect(record.diagnostic).toEqual({
      stopReason: "aborted",
      rawStopReason: "max_tokens",
      contentTypes: [],
      errorMessage: "provider hiccup",
    });
    expect(typeof record.latencyMs).toBe("number");
  });

  it("logs the full raw model reply without truncation", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const longText = "x".repeat(600);
    const authorize = createReviewPipeline(
      makePipeline({
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: longText }]),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const replyLog = debugCalls.find((c) => c.event === MODEL_REPLY_EVENT);
    expect(replyLog).toBeDefined();
    const raw = replyLog!.data.rawReply as string;
    expect(raw).toBe(longText);
    expect(raw.length).toBe(600);
  });

  it("defers when model call throws", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, timeoutMs: 100 },
        completeSimple: async () => {
          throw new Error("network error");
        },
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
  });

  it("redacts the raw reply in the always-on review record (defer failures)", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const credential = "sk-ant-api03-0123456789abcdef0123456789abcdef0123456789";
    const authorize = createReviewPipeline(
      makePipeline({
        // No JSON — a machinery defer whose raw text carries the credential.
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: `the prompt had ${credential} but {not json` },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.findLast((c) => c.event === DECISION_EVENT)!.data;
    const raw = record.rawReply as string;
    // The review stream is always on — never carry raw model text there.
    expect(raw).not.toContain(credential);
    // …but the redacted text must still BE there (kept-but-redacted, not
    // dropped entirely — the defer-failure raw reply is the replay material).
    expect(raw).toBeTruthy();
  });
});

describe("createReviewPipeline — deny history (the /ai-guard denied panel's data)", () => {
  // Write-side doctrine: ONLY fresh model-gate denies are recorded.
  // Mapping artifacts (mode-softened denies), machinery denials, and
  // cached-deny replays are absent by design — the panel answers "what
  // did the reviewer itself refuse", and each exclusion below is one of
  // those rules. (The read side — the panel — is pinned in
  // runtime-settings tests; this block pins what lands in the array.)

  it("records a fresh model deny with its teaching reason (un-instructed)", async () => {
    const denyHistory: DenyRecord[] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        denyHistory,
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), noLog);
    expect(denyHistory).toHaveLength(1);
    expect(denyHistory[0]).toMatchObject({
      surface: "bash",
      target: "rm -rf /",
      reason: "unsafe",
      riskLevel: "high",
    });
  });

  it("records an allow or defer not at all", async () => {
    const denyHistory: DenyRecord[] = [];
    const authorize = createReviewPipeline(
      makePipeline({ denyHistory }), // default fake replies allow
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(denyHistory).toHaveLength(0);
  });

  it("does not record a cached-deny replay", async () => {
    // Same ask twice with cache enabled: the deny is recorded on the
    // fresh review, the cache hit replays the verdict without a new entry.
    const denyHistory: DenyRecord[] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        denyHistory,
        config: { ...baseConfig, cache: { maxEntries: 8 } },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe"}' },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(denyHistory).toHaveLength(1);
  });

  it("does not record a machinery denial (strict mode's fail-closed deny)", async () => {
    // strict maps a machinery failure to deny — a mapping artifact, not
    // the reviewer's own judgment; the panel stays out of it.
    const denyHistory: DenyRecord[] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        denyHistory,
        config: { ...baseConfig, mode: "strict" },
        completeSimple: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
      }),
    );
    await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    expect(denyHistory).toHaveLength(0);
  });

  it("does not record a mode-softened deny (default's deny→defer mapping)", async () => {
    // The write side keys on the RAW model verdict: a fresh soft deny
    // under default is recorded once (the model refused — the emitted
    // defer is the mapping artifact, not the reviewer's judgment). The
    // cached replay emits defer again without re-entering the model
    // gate, so it adds no entry.
    const denyHistory: DenyRecord[] = [];
    const authorize = createReviewPipeline(
      makePipeline({
        denyHistory,
        config: { ...baseConfig, mode: "default", cache: { maxEntries: 8 } },
        completeSimple: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    // Fresh soft deny under default → emitted defer, but the model's own
    // deny is still what the reviewer refused → recorded once.
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    // Cached replay → emitted defer again, no new entry.
    await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(denyHistory).toHaveLength(1);
  });
});

describe("createReviewPipeline — transcript stripping", () => {
  // Target extraction (matchValues/value/command/path/target/toolName/skillName)
  // is tested directly in ask.test.ts as a pure function.

  it("strips transcript from session manager", async () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: { role: "user", content: "fix bug" },
      },
      {
        type: "message",
        id: "2",
        parentId: "1",
        timestamp: "x",
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "huge content" }],
        },
      },
    ];
    const authorize = createReviewPipeline(
      makePipeline({ sessionManager: makeSessionManagerWith(entries) }),
    );
    const verdict = await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({ kind: "allow" });
  });
});
