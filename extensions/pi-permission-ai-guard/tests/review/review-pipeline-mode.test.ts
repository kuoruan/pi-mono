/**
 * Mode-semantics tests for the review pipeline: the leniency ladder
 * (default / strict / lenient), mode edges, pre-call machinery failures,
 * the advisor-patch completeness set, and the per-lane deny/ask lanes.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  BREAKER_DENY_REASON,
  DECISION_EVENT,
  MODEL_REPLY_EVENT,
} from "#src/audit/decision-record.ts";
import { CircuitBreaker } from "#src/review/circuit-breaker.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import { uncertainDenyReason, withAgentInstruction } from "#src/review/verdict-mode.ts";
import { makeDetails } from "#test/fixtures.ts";

import {
  baseConfig,
  makeFakeCompleteSimple,
  makeQuery,
  noLog,
  makeRecordingLog,
  makeNotifySpy,
  expectVerdict,
  defaultRegistry,
  makePipeline,
} from "./pipeline-helpers.ts";

describe("createReviewPipeline — mode", () => {
  it("a session-scoped override takes precedence over the config mode", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        // config stays "default" — only the session override hands denies to the human.
        overrides: { mode: "lenient" },
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "defer" });
  });

  it("default maps a soft deny to defer and annotates the decision record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "defer" });
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision!.data.verdict).toBe("deny");
    expect(decision!.data.emittedVerdict).toBe("defer");
    expect(decision!.data.mode).toBe("default");
    expect(decision!.data.reason).toBe("unsafe");
  });

  it("default maps a cached deny to defer on a cache hit (no model call, notify fires)", async () => {
    let modelCalls = 0;
    const modelCall = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
      ])();
    };
    const { log, debugCalls } = makeRecordingLog();
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, cache: { maxEntries: 8 } },
        notify,
        modelCall,
      }),
    );
    const first = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
    expect(first).toEqual({ kind: "defer" });
    expect(modelCalls).toBe(1);

    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
    expect(second).toEqual({ kind: "defer" });
    expect(modelCalls).toBe(1); // cache hit — the deny is reused and mapped again

    // Cache hits are replays of the recorded model verdict — debug stream
    // only (log-stream doctrine).
    const cacheHit = debugCalls.filter((c) => c.event === DECISION_EVENT).at(-1)!;
    expect(cacheHit.data.gate).toBe("cache-hit");
    expect(cacheHit.data.verdict).toBe("deny");
    expect(cacheHit.data.emittedVerdict).toBe("defer");
    expect(cacheHit.data.mode).toBe("default");
    expect(notifications).toHaveLength(2); // fresh + cache hit both notify the human
  });

  it("default keeps a model defer as a defer", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm x" }, { kind: "defer" });
  });

  it("strict maps a model defer to deny carrying the clarification request", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), log);
    // The defer's reason becomes the deny's teaching reason — not a silent deny.
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction("needs the target path", "content"),
    });
    // The deny is mode-mapped (a synthesized teaching reason), not the
    // model's own deny — deny notifies cover only model denies, so this
    // stays silent (the ask did not hold or escalate; nothing reached
    // the human).
    expect(notifications).toEqual([]);
    const decision = reviewCalls.find((c) => c.event === DECISION_EVENT);
    expect(decision!.data.verdict).toBe("defer");
    expect(decision!.data.emittedVerdict).toBe("deny");
    // The agent received the synthesized teaching reason — never a
    // "clarification-suppressed" marker on a deny (nothing was swallowed).
    expect(decision!.data.emittedReason).toBe("needs the target path");
    expect(decision!.data.mode).toBe("strict");
  });

  it("strict maps a model defer without a reason to a generic deny reason", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        // Valid JSON defer, but the model omitted the clarification request.
        modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm x" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction(uncertainDenyReason("strict"), "content"),
    });
  });

  it("strict denies machinery failures — nothing falls to the user", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        // No JSON — a machinery failure (no-json), not the model's uncertainty.
        modelCall: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason: "reviewer could not complete the review (no-json) — strict mode denied the request",
      },
      "ask",
      "machinery",
    );
    // A deny needs no human interruption — no notify.
    expect(notifications).toEqual([]);
  });

  it("strict keeps a model deny terminal and notifies (denials have no dialog)", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), noLog);
    expect(verdict).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
    expect(notifications).toEqual([
      ["reviewer denied this request (risk high) — unsafe", "warning"],
    ]);
  });

  it("lenient denies still count toward the circuit breaker", async () => {
    let modelCalls = 0;
    const modelCall = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"no","riskLevel":"medium"}' },
      ])();
    };
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        modelCall,
      }),
    );
    for (let i = 0; i < 3; i++) {
      await expectVerdict(authorize, { value: `cmd-${i}` }, { kind: "defer" });
    }
    expect(modelCalls).toBe(3);

    // 3 consecutive model denies (even though all mapped to defers) trip the breaker.
    const fourth = await authorize(makeDetails({ value: "cmd-3" }), makeQuery("ask"), noLog);
    expect(fourth).toEqual({
      kind: "deny",
      reason: withAgentInstruction(BREAKER_DENY_REASON, "machinery"),
    });
    expect(modelCalls).toBe(3); // breaker short-circuited without a model call
  });
});

describe("createReviewPipeline — mode edges", () => {
  it("strict keeps a cached deny terminal on a cache hit (no model call, both passes notify)", async () => {
    let modelCalls = 0;
    const modelCall = async () => {
      modelCalls++;
      return makeFakeCompleteSimple([
        { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
      ])();
    };
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict", cache: { maxEntries: 8 } },
        notify,
        modelCall,
      }),
    );
    const first = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(first).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });

    // Cache hit: the stored model deny re-maps through auto (identity for
    // denies) without a model call — and both passes notify: v27 has no
    // dialog for denials, so the notify line is the operator's only copy
    // (repeats do not collapse).
    const second = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), noLog);
    expect(second).toEqual({
      kind: "deny",
      reason: withAgentInstruction("unsafe", "content"),
    });
    expect(modelCalls).toBe(1);
    expect(notifications).toEqual([
      ["reviewer denied this request (risk high) — unsafe", "warning"],
      ["reviewer denied this request (risk high) — unsafe", "warning"],
    ]);
  });

  it("a policy-decided ask defers regardless of the mode", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        modelCall: async () => {
          modelCalled = true;
          return {} as AssistantMessage;
        },
      }),
    );
    // The deterministic engine already allowed this: the link defers before
    // the model (and before any verdict-mode mapping could apply).
    await expectVerdict(authorize, { value: "ls -la" }, { kind: "defer" }, "allow");
    expect(modelCalled).toBe(false);
  });
});

describe("createReviewPipeline — pre-call machinery failures by mode", () => {
  // One lane per failure kind: how the injected deps break the pre-call
  // gates (model resolution, auth, transcript stripping).
  const FAILURE_INJECTIONS = {
    "model-unresolved": () => ({ registry: defaultRegistry({ find: () => undefined }) }),
    "auth-failed": () => ({
      registry: defaultRegistry({
        getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
      }),
    }),
    "transcript-error": () => ({
      sessionManager: {
        getSessionId: () => "s1",
        buildContextEntries: () => {
          throw new Error("boom");
        },
      },
    }),
  } as const;

  // strict and permissive are the fail-closed stops: the mode denies what
  // would fall to the human, silently (the human asked for exactly this).
  it.each(
    (
      [
        { mode: "strict", failure: "model-unresolved" },
        { mode: "strict", failure: "auth-failed" },
        { mode: "strict", failure: "transcript-error" },
        { mode: "permissive", failure: "model-unresolved" },
      ] as const
    ).map(({ mode, failure }) => ({
      mode,
      failure,
      inject: FAILURE_INJECTIONS[failure],
    })),
  )(
    "$mode denies a pre-call machinery failure ($failure) and stays silent",
    async ({ mode, failure, inject }) => {
      const { notifications, notify } = makeNotifySpy();
      const authorize = createReviewPipeline(
        makePipeline({
          config: { ...baseConfig, mode },
          notify,
          ...inject(),
        }),
      );
      await expectVerdict(
        authorize,
        { value: "npm test" },
        {
          kind: "deny",
          reason: `reviewer could not complete the review (${failure}) — ${mode} mode denied the request`,
        },
        "ask",
        "machinery",
      );
      expect(notifications).toEqual([]);
    },
  );

  // default and lenient defer the same failure to the human and say why.
  it.each(["default", "lenient"] as const)(
    "notifies when a pre-call machinery failure forces a defer in %s mode",
    async (mode) => {
      const { notifications, notify } = makeNotifySpy();
      const authorize = createReviewPipeline(
        makePipeline({
          config: { ...baseConfig, mode },
          registry: defaultRegistry({ find: () => undefined }),
          notify,
        }),
      );
      await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
      expect(notifications).toEqual([
        ["reviewer could not complete the review (model-unresolved) — deferring to you", "warning"],
      ]);
    },
  );

  it("notifies when an in-call machinery failure (empty reply) forces a defer — every time", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        modelCall: makeFakeCompleteSimple([]),
        notify,
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    // Repeats do not collapse: a second failure re-explains itself.
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer could not complete the review (empty-reply) — deferring to you", "warning"],
      ["reviewer could not complete the review (empty-reply) — deferring to you", "warning"],
    ]);
  });
});

describe("createReviewPipeline — advisor patches (strict completeness + audit)", () => {
  it("strict denies a no-target ask like any other machinery failure", async () => {
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "strict" } }),
    );
    await expectVerdict(
      authorize,
      { value: "", command: "" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (no-target) — strict mode denied the request",
      },
      "ask",
      "machinery",
    );
  });

  it("default still defers a no-target ask", async () => {
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "default" } }),
    );
    await expectVerdict(authorize, { value: "", command: "" }, { kind: "defer" });
  });

  it("strict pre-call denies carry the emitted reason into the audit record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        registry: defaultRegistry({ find: () => undefined }),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.emittedReason).toBe(
      "reviewer could not complete the review (model-unresolved) — strict mode denied the request",
    );
  });

  it("transcript-error writes a review-stream record in strict (and defers otherwise)", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        sessionManager: {
          getSessionId: () => "s1",
          buildContextEntries: () => {
            throw new Error("boom");
          },
        },
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.gate).toBe("transcript-error");
    expect(record.emittedVerdict).toBe("deny");
    expect(record.emittedReason).toBe(
      "reviewer could not complete the review (transcript-error) — strict mode denied the request",
    );
  });

  it("default/lenient model-defer mirrors the clarification request to the human", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        modelCall: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"which package manager does this project use?"}',
          },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer asks — which package manager does this project use?", "info"],
    ]);
  });

  it("model-defer mirror keeps a long clarification on one line", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        modelCall: makeFakeCompleteSimple([
          {
            type: "text",
            text: JSON.stringify({
              verdict: "defer",
              reason:
                "this clarification is deliberately long enough that the notify copy must truncate it to stay on one line",
            }),
          },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "defer" });
    expect(notifications).toHaveLength(1);
    // The clarification goes out whole: the operator must be able to
    // answer the question, and only a runaway ramble (200+) truncates.
    expect(notifications[0]![0]).not.toContain("\n");
    expect(notifications[0]![0]).toContain(
      "this clarification is deliberately long enough that the notify copy must truncate it to stay on one line",
    );
    expect(notifications[0]![0]).not.toContain("[...truncated...]");
  });

  it("a benign-leaned defer asks in default mode — the intent question reaches the authorizer", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        modelCall: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
          },
        ]),
      }),
    );
    // baseConfig mode is default — an unresolved verdict keeps its ask
    // path here: the lean is recorded, but the human answers the intent
    // question (the thing the model structurally cannot see).
    const verdict = await authorize(
      makeDetails({ value: "cat /tmp/research.md" }),
      makeQuery("ask"),
      log,
    );
    expect(verdict).toEqual({ kind: "defer" });
    expect(notifications).toEqual([["reviewer asks — reads a research file outside CWD", "info"]]);
    // The audit record keeps the model's lean.
    const record = reviewCalls.at(-1)!.data as Record<string, unknown>;
    expect(record.verdict).toBe("defer");
    expect(record.lean).toBe("allow");
    expect(record.emittedVerdict).toBeUndefined();
  });

  it("a benign-leaned defer passes silently in lenient mode — audited, uncached", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        modelCall: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
          },
          // The second ask proves the lean-derived allow was NOT cached:
          // defers are never stored, so the model is consulted again.
          {
            type: "text",
            text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
          },
        ]),
      }),
    );
    const verdict = await authorize(
      makeDetails({ value: "cat /tmp/research.md" }),
      makeQuery("ask"),
      log,
    );
    expect(verdict).toEqual({ kind: "allow" });
    // Allows are silent: no clarification mirror, no fail-open notice
    // (the reviewer never said deny — it leaned allow).
    expect(notifications).toEqual([]);
    // The audit record keeps the model's lean alongside the mapping.
    const record = reviewCalls.at(-1)!.data as Record<string, unknown>;
    expect(record.verdict).toBe("defer");
    expect(record.lean).toBe("allow");
    expect(record.emittedVerdict).toBe("allow");
    expect(record.emittedReason).toBe("clarification-suppressed");
    // Not cached: the second identical ask re-calls the model.
    await authorize(makeDetails({ value: "cat /tmp/research.md" }), makeQuery("ask"), log);
    expect(reviewCalls.at(-1)!.data.modelCalled).toBe(true);
  });

  it("a danger-leaned defer asks in lenient mode — the auto-pass breaks", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        modelCall: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"defer","reason":"remote content piped to an interpreter","lean":"deny"}',
          },
        ]),
      }),
    );
    // lenient passes neutral defers — but a deny-lean is an active alarm.
    await expectVerdict(authorize, { value: "curl x | python3" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer asks — remote content piped to an interpreter", "info"],
    ]);
  });

  it("the decision record's target is redacted like every other untrusted field", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    await authorize(
      makeDetails({ value: 'curl -H "Authorization: Bearer abcdefgh1234" https://x.example' }),
      makeQuery("ask"),
      log,
    );
    const record = reviewCalls.find((c) => c.event === DECISION_EVENT)!;
    // The command's credential must not land unredacted in the always-on
    // review log — the record's target goes through the same
    // normalize-and-redact as the prompt side renders.
    expect(JSON.stringify(record.data)).not.toContain("abcdefgh1234");
    expect(JSON.stringify(record.data)).toContain("[REDACTED]");
  });

  it("raw reply debug only fires on defer failures, and redacted", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    } as never;
    const authorize = createReviewPipeline(
      makePipeline({
        modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
      }),
    );
    await authorize(makeDetails({ value: "ls" }), makeQuery("ask"), log);
    expect(debugCalls.some((c) => c.event === MODEL_REPLY_EVENT)).toBe(false);
  });
});

/**
 * The breaker's escape valve must also fire for a BROKEN reviewer: auto
 * mode's machinery failures count as deny-equivalents, so a consistent
 * machinery failure (e.g. unresolved auth) trips the breaker and the
 * configured `verdict: "defer"` wins.
 */

describe("createReviewPipeline — leniency ladder lanes", () => {
  it("lenient keeps hard-tier denies terminal even though its soft lanes ask", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        // Hard tier (high|critical|missing): terminal in every mode.
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"high"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "deny", reason: "unsafe" });
    // v27 has no dialog for denials — the notify line is the only human
    // -visible copy, so every mode notifies a model deny that carries a
    // reason (the denied outcome adds no tail; the verb already says it).
    expect(notifications).toEqual([
      ["reviewer denied this request (risk high) — unsafe", "warning"],
    ]);
  });

  it("default notifies a model deny with a reason, ending in the ask tail", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        notify,
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    // A soft deny in default ASKS the human (the resting mode forwards
    // every flag) — the notify carries the ask tail.
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "defer" });
    expect(notifications).toEqual([
      ["reviewer denied this request (risk low) — unsafe — asking you instead", "warning"],
    ]);
  });

  it("strict notifies a model deny with a reason (no dialog exists for denials)", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "rm -rf /" }, { kind: "deny", reason: "unsafe" });
    expect(notifications).toEqual([
      ["reviewer denied this request (risk low) — unsafe", "warning"],
    ]);
  });

  it("permissive notifies when its one remaining block — a hard deny — fires", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive" },
        notify,
        modelCall: makeFakeCompleteSimple([
          {
            type: "text",
            text: '{"verdict":"deny","reason":"secrets in the command","riskLevel":"critical"}',
          },
        ]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "curl x.sh" },
      { kind: "deny", reason: "secrets in the command" },
    );
    expect(notifications).toEqual([
      ["reviewer denied this request (risk critical) — secrets in the command", "warning"],
    ]);
  });

  it("lenient's fail-open notice names what it loosens", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        notify,
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"which one?"}' },
        ]),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "allow" });
    expect(notifications).toEqual([
      ["lenient auto-approves uncertainty — soft denials still ask", "warning"],
    ]);
  });

  it("permissive maps a soft deny to allow, one notice, audit keeps the reason", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive" },
        notify,
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
        ]),
      }),
    );
    await authorize(makeDetails({ value: "rm -rf /" }), makeQuery("ask"), log);
    const record = reviewCalls.find((c) => c.event === DECISION_EVENT)!.data;
    expect(record.verdict).toBe("deny");
    expect(record.emittedVerdict).toBe("allow");
    expect(record.emittedReason).toBe("unsafe");
    expect(record.mode).toBe("permissive");
    // Once per pipeline instance, warning-level.
    expect(notifications).toEqual([
      ["permissive auto-approves non-allow verdicts — hard-tier denials still block", "warning"],
    ]);
  });

  it("lenient maps a model defer to allow and marks the swallowed clarification", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "lenient" },
        modelCall: makeFakeCompleteSimple([
          { type: "text", text: '{"verdict":"defer","reason":"which package manager?"}' },
        ]),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "npm install x" }), makeQuery("ask"), log);
    expect(verdict).toEqual({ kind: "allow" });
    const record = reviewCalls.find((c) => c.event === DECISION_EVENT)!.data;
    expect(record.verdict).toBe("defer");
    expect(record.emittedVerdict).toBe("allow");
    expect(record.emittedReason).toBe("clarification-suppressed");
  });

  it("permissive still denies machinery failures and counts them into the breaker", async () => {
    const { notifications, notify } = makeNotifySpy();
    const breaker = new CircuitBreaker();
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "permissive",
          circuitBreaker: { consecutive: 2, total: 20, verdict: "defer" },
        },
        circuitBreaker: breaker,
        notify,
        // No JSON — a machinery failure (no-json), never an allow.
        modelCall: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason:
          "reviewer could not complete the review (no-json) — permissive mode denied the request",
      },
      "ask",
      "machinery",
    );
    expect(notifications).toEqual([]);
    // The machinery deny counted into the recoverable consecutive tier.
    expect(breaker.isTripped({ consecutive: 1, total: 20, verdict: "deny" })).toBe(true);
  });

  it("the fail-open notice fires once per pipeline, not per mapped allow", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "permissive" },
        notify,
        modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
      }),
    );
    for (let i = 0; i < 3; i++) {
      await authorize(makeDetails({ value: `cmd-${i}` }), makeQuery("ask"), noLog);
    }
    expect(notifications.length).toBe(1);
    expect(notifications[0]![1]).toBe("warning");
  });

  it("no-target asks write a review-stream record and deny only under the extremes", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "default" } }),
    );
    await authorize(makeDetails({ value: "", command: "" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.gate).toBe("no-target");
    expect(record.verdict).toBe("defer");
    expect(record.emittedVerdict).toBeUndefined();

    // permissive: same ask denies with the machinery reason and a mapped record.
    const permissiveCalls: { event: string; data: Record<string, unknown> }[] = [];
    const permissiveLog = {
      review: (event: string, data: Record<string, unknown>) =>
        permissiveCalls.push({ event, data }),
      debug: () => {},
    } as never;
    const permissive = createReviewPipeline(
      makePipeline({ config: { ...baseConfig, mode: "permissive" } }),
    );
    await permissive(makeDetails({ value: "", command: "" }), makeQuery("ask"), permissiveLog);
    const deny = permissiveCalls.at(-1)!.data;
    expect(deny.gate).toBe("no-target");
    expect(deny.verdict).toBe("defer");
    expect(deny.emittedVerdict).toBe("deny");
    expect(deny.emittedReason).toBe(
      "reviewer could not complete the review (no-target) — permissive mode denied the request",
    );
  });
});
