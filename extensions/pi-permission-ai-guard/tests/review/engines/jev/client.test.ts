import { afterEach, describe, expect, it, vi } from "vitest";

import { buildJevRequest, createTypesafeClient } from "#src/review/engines/jev/client.ts";
import type { AskContext } from "#src/review/request/ask.ts";
import { buildAskContext } from "#src/review/request/ask.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";
import { ev, makeDetails, payload } from "#test/fixtures.ts";

function ask(): AskContext {
  return buildAskContext(makeDetails({ value: "rm -rf /tmp/x" }), "/project");
}

function request(overrides: Partial<ReviewRequestContext> = {}): ReviewRequestContext {
  return { ask: ask(), target: "rm -rf /tmp/x", ...overrides };
}

function transcript(overrides: Partial<StrippedTranscript> = {}): StrippedTranscript {
  return {
    trustedIntent: ["clean up temp files"],
    toolCalls: [],
    strippedCount: 0,
    ...overrides,
  };
}

describe("buildJevRequest", () => {
  it("builds the built-in questions with the model id", () => {
    const req = buildJevRequest(transcript(), request(), null, "jev-1.13");
    expect(req.model).toBe("jev-1.13");
    expect(Object.keys(req.questions).toSorted()).toEqual([
      "danger_category",
      "intent_match",
      "risk",
    ]);
    expect(req.questions.danger_category.type).toBe("choice");
    expect(req.questions.risk.type).toBe("score");
    expect(req.questions.intent_match.criteria).toMatchObject({
      true: expect.any(String),
      false: expect.any(String),
    });
  });

  it("puts the anchor, earlier context, and command in state", () => {
    const req = buildJevRequest(
      transcript({ trustedIntent: ["older", "clean up temp files"], toolCalls: ["ls"] }),
      request(),
      null,
      "jev-1.13",
    );
    expect(req.state).toMatchObject({
      command: "rm -rf /tmp/x",
      authorization_anchor: "clean up temp files",
      earlier_context: ["older"],
      tool_calls: ["ls"],
      working_directory: "/project",
    });
  });

  it("carries tool input in state for a tool ask with empty flagged elements", () => {
    // A tool-kind ask whose value is empty flags nothing — exactly the
    // blind-on-intent shape the tool_input key exists for (B1 regression).
    const toolAsk = buildAskContext(
      makeDetails({
        payload: payload("tool", { value: "", surface: "mcp" }, [ev("input", "preview")]),
      }),
      "/project",
    );
    expect(toolAsk.flaggedElements).toEqual([]);
    const req = buildJevRequest(transcript(), { ask: toolAsk, target: "mcp" }, null, "jev-1.13");
    expect(req.state).toMatchObject({ tool_input: "preview" });
  });

  it("uses (none found) when there is no trusted intent", () => {
    const req = buildJevRequest(transcript({ trustedIntent: [] }), request(), null, "jev-1.13");
    expect(req.state).toMatchObject({ authorization_anchor: "(none found)" });
  });

  it("appends a string shorthand as background to every question", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      "Deploys go through railway up.",
      "jev-1.13",
    );
    for (const q of Object.values(req.questions)) {
      expect(String(q.instructions)).toContain("Deploys go through railway up.");
    }
  });

  it("overlays a per-question string only on that question", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      { questions: { intent_match: "A deploy without a service name is not authorization." } },
      "jev-1.13",
    );
    expect(String(req.questions.intent_match.instructions)).toContain("not authorization");
    expect(String(req.questions.risk.instructions)).not.toContain("not authorization");
  });

  it("overlays a per-question string on danger_category", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      { questions: { danger_category: "A deploy tool wiping its cache counts as none." } },
      "jev-1.13",
    );
    expect(String(req.questions.danger_category.instructions)).toContain("wiping its cache");
    expect(String(req.questions.risk.instructions)).not.toContain("wiping its cache");
  });

  it("overlays a per-question string on risk", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      { questions: { risk: "Railway deploys are reversible — score accordingly." } },
      "jev-1.13",
    );
    expect(String(req.questions.risk.instructions)).toContain("reversible");
    expect(String(req.questions.danger_category.instructions)).not.toContain("reversible");
  });

  it("composes object overlays as structured question+context", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      { background: { deploy_tool: "railway up", forbidden: ["kubectl"] } },
      "jev-1.13",
    );
    expect(req.questions.risk.instructions).toEqual({
      question: expect.any(String),
      context: { deploy_tool: "railway up", forbidden: ["kubectl"] },
    });
  });

  it("keeps the shared background context when a question adds its own", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      {
        background: { deploy_tool: "railway up" },
        questions: { risk: { rubric_note: "reversible" } },
      },
      "jev-1.13",
    );
    expect(req.questions.risk.instructions).toEqual({
      question: expect.any(String),
      context: { deploy_tool: "railway up", rubric_note: "reversible" },
    });
  });

  it("appends a per-question string to the question text, keeping the background context", () => {
    const req = buildJevRequest(
      transcript(),
      request(),
      {
        background: { deploy_tool: "railway up" },
        questions: { risk: "score conservatively" },
      },
      "jev-1.13",
    );
    expect(req.questions.risk.instructions).toEqual({
      question: expect.stringContaining("score conservatively"),
      context: { deploy_tool: "railway up" },
    });
  });

  it("falls back to the resolved target when the ask carries no action text", () => {
    // A degraded (forwarded) ask whose value is empty still has a resolved
    // target; the state must carry it rather than an empty command.
    const req = buildJevRequest(
      transcript(),
      { ask: buildAskContext(makeDetails({ value: "" }), "/project"), target: "/etc/passwd" },
      null,
      "jev-1.13",
    );
    const state = req.state as { command: string };
    expect(state.command).toBe("/etc/passwd");
  });

  it("redacts the ask fields on their way to the service", () => {
    // The pipeline hands engines the raw projection; only the transcript
    // arrives sanitized, so the Jev state redacts the ask itself (the LLM
    // prompt's twin).
    const secret = "sk-ant-api03-abcdef1234567890abcdefABCDEF1234567890";
    const req = buildJevRequest(
      transcript(),
      request({
        ask: buildAskContext(makeDetails({ value: `export TOKEN=${secret}` }), "/project"),
      }),
      null,
      "jev-1.13",
    );
    const state = req.state as { command: string };
    expect(state.command).not.toContain(secret);
    expect(state.command).toContain("[REDACTED]");
  });
});

describe("createTypesafeClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes connection fields through without defaults", () => {
    // No SDK defaults are shadowed here: undefined reaches the client, which
    // applies env fallback + built-in URL itself. The SDK eagerly
    // rejects a keyless client at construction, so supply the env fallback a
    // configured deployment would have.
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const client = createTypesafeClient({ baseUrl: undefined, apiKey: undefined });
    expect(typeof client.systemOne).toBe("function");
  });
});
