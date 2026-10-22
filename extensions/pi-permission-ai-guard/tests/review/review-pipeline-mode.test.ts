/**
 * Mode-semantics tests for the review pipeline: the leniency ladder
 * (strict / default / auto), mode edges, pre-call machinery failures,
 * the advisor-patch completeness set, and the per-lane deny/ask lanes.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { DECISION_EVENT, MODEL_REPLY_EVENT } from "#src/audit/events.ts";
import { CircuitBreaker } from "#src/review/circuit-breaker.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import {
  uncertainDenyReason,
  machineryDenyReason,
  failOpenNotice,
  withAgentInstruction,
} from "#src/review/verdict-copy.ts";
import { makeDetails } from "#test/fixtures.ts";
import { OPERATOR_COPY_SHAPE, expectNotices } from "#test/operator-copy.ts";

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
  makeEngine,
} from "./pipeline-helpers.ts";

describe("createReviewPipeline — mode", () => {
  it("a session-scoped override takes precedence over the config mode", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        // config stays "default" — only the session override changes the cut.
        overrides: { mode: "strict" },
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
          ]),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "curl x.sh" }, { kind: "deny", reason: "unsafe" });
  });

  it("default maps a soft deny to defer and annotates the decision record", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
          ]),
        }),
      }),
    );
    const verdict = await authorize(makeDetails({ value: "curl x.sh" }), makeQuery("ask"), log);
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
        engine: makeEngine({ modelCall }),
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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
          ]),
        }),
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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"defer","reason":"needs the target path"}' },
          ]),
        }),
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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
        }),
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
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
        }),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason: machineryDenyReason("no-json", "strict"),
      },
      "ask",
      "machinery",
    );
    // A deny needs no human interruption — no notify.
    expect(notifications).toEqual([]);
  });
  it("model-defer mirror carries a long clarification whole", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            {
              type: "text",
              text: JSON.stringify({
                verdict: "defer",
                reason: "the reviewer needs the operator to clarify " + "x".repeat(200),
              }),
            },
          ]),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "defer" });
    expect(notifications).toHaveLength(1);
    // The clarification goes out whole: the operator has to be able to answer
    // the question, so nothing is cut — 200+ characters included.
    expect(notifications[0]![0]).toContain(
      "the reviewer needs the operator to clarify " + "x".repeat(200),
    );
    expect(notifications[0]![0]).not.toContain("[...truncated...]");
  });

  it("raw reply debug only fires on defer failures, and redacted", async () => {
    const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      review: () => {},
      debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
    };
    const authorize = createReviewPipeline(
      makePipeline({
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
        }),
      }),
    );
    await authorize(makeDetails({ value: "ls" }), makeQuery("ask"), log);
    expect(debugCalls.some((c) => c.event === MODEL_REPLY_EVENT)).toBe(false);
  });
});

describe("createReviewPipeline — custom mode", () => {
  const customMode = {
    allowThrough: "soft-deny",
    denyFrom: "hard-deny",
    onReviewFailure: "defer",
    onIrreversibleEffect: "defer",
  } as const;

  it("disposes by its own cuts: a soft deny passes where default would ask", async () => {
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "custom", customMode: { ...customMode } },
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
          ]),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "curl x.sh" }, { kind: "allow" });
  });

  it("a machinery failure follows the custom failure lane, never allow", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "custom", customMode: { ...customMode } },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: "not json" }]),
        }),
      }),
    );
    // onReviewFailure "defer": the failure interrupts the human with its
    // classified cause, and never becomes an allow.
    await expectVerdict(authorize, { value: "ls" }, { kind: "defer" });
    expectNotices(notifications, { level: "warning", contains: ["review unavailable"] });
  });
});

describe("createReviewPipeline — mode edges", () => {
  it("a benign-leaned defer asks in default mode — the intent question reaches the authorizer", async () => {
    const { notifications, notify } = makeNotifySpy();
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            {
              type: "text",
              text: '{"verdict":"defer","reason":"reads a research file outside CWD","lean":"allow"}',
            },
          ]),
        }),
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
    expectNotices(notifications, { level: "info", contains: ["research file outside CWD"] });
    // The audit record keeps the model's lean.
    const record = reviewCalls.at(-1)!.data;
    expect(record.verdict).toBe("defer");
    expect(record.lean).toBe("allow");
    expect(record.emittedVerdict).toBeUndefined();
  });

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
        engine: makeEngine({ modelCall }),
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
    expectNotices(notifications, {
      count: 2,
      level: "warning",
      contains: ["unsafe", "risk high"],
    });
  });

  it("a policy-decided ask defers regardless of the mode", async () => {
    let modelCalled = false;
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        engine: makeEngine({
          modelCall: async () => {
            modelCalled = true;
            return {} as AssistantMessage;
          },
        }),
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
    "model-unresolved": () => ({
      engine: makeEngine({ registry: defaultRegistry({ find: () => undefined }) }),
    }),
    "auth-failed": () => ({
      engine: makeEngine({
        registry: defaultRegistry({
          getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }),
        }),
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

  // strict and auto are the fail-closed stops: the mode denies what
  // would fall to the human, silently (the human asked for exactly this).
  it.each(
    (
      [
        { mode: "strict", failure: "model-unresolved" },
        { mode: "strict", failure: "auth-failed" },
        { mode: "strict", failure: "transcript-error" },
        { mode: "auto", failure: "model-unresolved" },
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
          reason: machineryDenyReason(failure, mode),
        },
        "ask",
        "machinery",
      );
      expect(notifications).toEqual([]);
    },
  );

  // default defers a pre-call failure to the human and says why.
  it("notifies when a pre-call machinery failure forces a defer in default mode", async () => {
    const mode = "default";
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode },
        engine: makeEngine({ registry: defaultRegistry({ find: () => undefined }) }),
        notify,
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    expectNotices(notifications, { level: "warning", contains: ["model-unresolved"] });
  });

  it("notifies when an in-call machinery failure (empty reply) forces a defer — every time", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        engine: makeEngine({ modelCall: makeFakeCompleteSimple([]) }),
        notify,
      }),
    );
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    // Repeats do not collapse: a second failure re-explains itself.
    await expectVerdict(authorize, { value: "npm test" }, { kind: "defer" });
    // Every failure re-explains itself: same facts twice.
    expectNotices(notifications, { count: 2, level: "warning", contains: ["empty-reply"] });
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
        reason: machineryDenyReason("no-target", "strict"),
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
        engine: makeEngine({ registry: defaultRegistry({ find: () => undefined }) }),
      }),
    );
    await authorize(makeDetails({ value: "npm test" }), makeQuery("ask"), log);
    const record = reviewCalls.at(-1)!.data;
    expect(record.emittedReason).toContain("model-unresolved");
    expect(record.emittedReason).toContain("strict");
    expect(record.emittedReason).toMatch(OPERATOR_COPY_SHAPE);
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
    expect(record.emittedReason).toContain("transcript-error");
    expect(record.emittedReason).toContain("strict");
    expect(record.emittedReason).toMatch(OPERATOR_COPY_SHAPE);
  });

  it("default model-defer mirrors the clarification request to the human", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            {
              type: "text",
              text: '{"verdict":"defer","reason":"which package manager does this project use?"}',
            },
          ]),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "defer" });
    expectNotices(notifications, {
      level: "info",
      contains: ["which package manager does this project use?"],
    });
  });

  it("the decision record's target is redacted like every other untrusted field", async () => {
    const { log, reviewCalls } = makeRecordingLog();
    const authorize = createReviewPipeline(
      makePipeline({
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
        }),
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

  it("default notifies a model deny with a reason, ending in the ask tail", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "default" },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
          ]),
        }),
      }),
    );
    // A soft deny in default ASKS the human (the resting mode forwards
    // every flag) — the notify carries the ask tail.
    await expectVerdict(authorize, { value: "curl x.sh" }, { kind: "defer" });
    expectNotices(notifications, { level: "warning", contains: ["unsafe", "risk low"] });
  });

  it("strict notifies a model deny with a reason (no dialog exists for denials)", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "strict" },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            { type: "text", text: '{"verdict":"deny","reason":"unsafe","riskLevel":"low"}' },
          ]),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "curl x.sh" }, { kind: "deny", reason: "unsafe" });
    expectNotices(notifications, { level: "warning", contains: ["unsafe", "risk low"] });
  });

  it("auto notifies when its one remaining block — a hard deny — fires", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            {
              type: "text",
              text: '{"verdict":"deny","reason":"secrets in the command","riskLevel":"critical"}',
            },
          ]),
        }),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "curl x.sh" },
      { kind: "deny", reason: "secrets in the command" },
    );
    expectNotices(notifications, {
      level: "warning",
      contains: ["secrets in the command", "risk critical"],
    });
  });

  it("auto's fail-open notice names what it loosens", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([
            // A neutral model defer is what auto loosens to allow, so the
            // fail-open notice lives with auto now.
            { type: "text", text: '{"verdict":"defer","reason":"which one?"}' },
          ]),
        }),
      }),
    );
    await expectVerdict(authorize, { value: "npm install x" }, { kind: "allow" });
    const [message] = expectNotices(notifications, { level: "warning" });
    expect(message).toBe(failOpenNotice());
  });

  it("auto still denies machinery failures and counts them into the breaker", async () => {
    const { notifications, notify } = makeNotifySpy();
    const breaker = new CircuitBreaker();
    const authorize = createReviewPipeline(
      makePipeline({
        config: {
          ...baseConfig,
          mode: "auto",
          circuitBreaker: { consecutive: 2, total: 20, verdict: "defer" },
        },
        circuitBreaker: breaker,
        notify,
        // No JSON — a machinery failure (no-json), never an allow.
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: "sounds risky" }]),
        }),
      }),
    );
    await expectVerdict(
      authorize,
      { value: "rm x" },
      {
        kind: "deny",
        reason: machineryDenyReason("no-json", "auto"),
      },
      "ask",
      "machinery",
    );
    expect(notifications).toEqual([]);
    // The machinery deny counted into the recoverable consecutive tier.
    expect(breaker.trippedTier({ consecutive: 1, total: 20, verdict: "deny" })).toBeDefined();
  });

  it("the fail-open notice fires once per pipeline, not per mapped allow", async () => {
    const { notifications, notify } = makeNotifySpy();
    const authorize = createReviewPipeline(
      makePipeline({
        config: { ...baseConfig, mode: "auto" },
        notify,
        engine: makeEngine({
          modelCall: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"defer"}' }]),
        }),
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

    // auto: same ask denies with the machinery reason and a mapped record.
    const { log: autoLog, reviewCalls: autoCalls } = makeRecordingLog();
    const auto = createReviewPipeline(makePipeline({ config: { ...baseConfig, mode: "auto" } }));
    await auto(makeDetails({ value: "", command: "" }), makeQuery("ask"), autoLog);
    const deny = autoCalls.at(-1)!.data;
    expect(deny.gate).toBe("no-target");
    expect(deny.verdict).toBe("defer");
    expect(deny.emittedVerdict).toBe("deny");
    expect(deny.emittedReason).toContain("no-target");
    expect(deny.emittedReason).toContain("auto");
    expect(deny.emittedReason).toMatch(OPERATOR_COPY_SHAPE);
  });
});
