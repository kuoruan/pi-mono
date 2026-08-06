import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { stripTranscript } from "#src/transcript-stripper.ts";

function makeEntry(type: string, data: Record<string, unknown>): unknown {
  return {
    type,
    id: Math.random().toString(36),
    parentId: null,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

function makeMessage(role: string, content: unknown): unknown {
  return makeEntry("message", { message: { role, content } });
}

function makeAssistantWithToolCall(toolName: string, args: unknown): unknown {
  return makeEntry("message", {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll run this command." },
        { type: "toolCall", name: toolName, arguments: args },
      ],
    },
  });
}

function makeToolResult(toolName: string, result: string): unknown {
  return makeEntry("message", {
    message: {
      role: "toolResult",
      toolName,
      content: [{ type: "text", text: result }],
    },
  });
}

function makeCompaction(summary: string): unknown {
  return makeEntry("compaction", { summary, firstKeptEntryId: "x" });
}

const opts = { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 500 };

describe("stripTranscript", () => {
  it("extracts user messages as trusted intent", () => {
    const entries = [
      makeMessage("user", "fix the bug"),
      makeMessage("assistant", "I'll help"),
      makeMessage("user", "also check tests"),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent).toContain("fix the bug");
    expect(result.trustedIntent).toContain("also check tests");
  });

  it("strips assistant text, keeps only tool calls", () => {
    const entries = [
      makeMessage("user", "do something"),
      makeAssistantWithToolCall("bash", { command: "ls -la" }),
      makeMessage("assistant", [{ type: "text", text: "Done!" }]),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.toolCalls).toContain("bash: " + JSON.stringify({ command: "ls -la" }));
    expect(result.toolCalls).not.toContain("Done!");
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("completely removes tool results", () => {
    const entries = [
      makeMessage("user", "read the file"),
      makeToolResult("read", "line1\nline2\nline3\n... 500 lines of code ..."),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent).toContain("read the file");
    expect(result.toolCalls.length).toBe(0);
    expect(result.strippedCount).toBeGreaterThan(0);
    // Tool result text should NOT appear anywhere
    expect(JSON.stringify(result)).not.toContain("line1");
  });

  it("keeps ask_user_question results as trusted intent", () => {
    const entries = [
      makeEntry("message", {
        message: {
          role: "toolResult",
          toolName: "ask_user_question",
          content: [{ type: "text", text: "User chose option A" }],
        },
      }),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent).toContain("User chose option A");
  });

  it("strips compaction summaries so they cannot authorize actions", () => {
    const entries = [
      makeCompaction("Summary of previous work: fixed auth module"),
      makeMessage("user", "now fix the tests"),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.some((s) => s.includes("Summary of previous work"))).toBe(false);
    expect(result.trustedIntent).toContain("now fix the tests");
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("respects maxUserMessages limit", () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeMessage("user", `message ${i}`));
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, { ...opts, maxUserMessages: 3 });
    expect(result.trustedIntent.length).toBe(3);
    // Should keep most recent 3
    expect(result.trustedIntent).toContain("message 9");
    expect(result.trustedIntent).toContain("message 8");
    expect(result.trustedIntent).toContain("message 7");
  });

  it("respects maxToolCalls limit", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeAssistantWithToolCall("bash", { command: `cmd${i}` }),
    );
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, { ...opts, maxToolCalls: 5 });
    expect(result.toolCalls.length).toBe(5);
  });

  it("truncates long entries to maxCharsPerEntry", () => {
    const longText = "x".repeat(2000);
    const entries = [makeMessage("user", longText)];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, { ...opts, maxCharsPerEntry: 100 });
    expect(result.trustedIntent[0]!.length).toBeLessThan(200);
    expect(result.trustedIntent[0]).toContain("truncated");
  });

  it("returns empty arrays for empty session", () => {
    const sm = { buildContextEntries: () => [] as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.length).toBe(0);
    expect(result.toolCalls.length).toBe(0);
  });

  it("handles message entry with missing message field", () => {
    const entries = [{ type: "message", id: "1", parentId: null, timestamp: "x" }];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.length).toBe(0);
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("handles message entry with missing role", () => {
    const entries = [{ type: "message", id: "1", parentId: null, timestamp: "x", message: {} }];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.length).toBe(0);
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("strips unknown role messages", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: { role: "system", content: "hello" },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.length).toBe(0);
    expect(result.toolCalls.length).toBe(0);
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("treats all user-role messages as trusted (toolName is toolResult-only)", () => {
    // A real UserMessage never carries toolName; ask_user_question answers
    // arrive as toolResult entries (tested above). Every user message is
    // trusted intent regardless.
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: {
          role: "user",
          content: [{ type: "text", text: "User message" }],
        },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent).toContain("User message");
  });

  it("strips compaction entries with fromHook=true as untrusted", () => {
    const entries = [
      {
        type: "compaction",
        id: "1",
        parentId: null,
        timestamp: "x",
        summary: "hook summary",
        firstKeptEntryId: "x",
        fromHook: true,
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.length).toBe(0);
    expect(result.strippedCount).toBe(1);
  });

  it("strips custom_message entries", () => {
    const entries = [
      {
        type: "custom_message",
        id: "1",
        parentId: null,
        timestamp: "x",
        content: [{ type: "text", text: "custom" }],
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("handles assistant with text but no tool calls", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: { role: "assistant", content: [{ type: "text", text: "Just thinking..." }] },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.toolCalls.length).toBe(0);
    expect(result.strippedCount).toBeGreaterThan(0);
  });

  it("falls back to String() when tool-call arguments are unstringifiable (circular)", () => {
    // JSON.stringify throws on circular refs — the catch branch must still
    // produce a usable (if ugly) arg string, not crash.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "write", arguments: circular }],
        },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]).toContain("write:");
  });

  it("handles toolCall with toolName (no name) and string arguments", () => {
    // A toolCall block with `toolName` instead of `name`, and `arguments` as
    // a pre-stringified value — covers the fallback-name and string-arg paths.
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", toolName: "custom-tool", arguments: '{"path":"x"}' }],
        },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]).toContain("custom-tool:");
  });

  it("uses 'unknown' when a toolCall has neither name nor toolName", () => {
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", arguments: {} }],
        },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]).toContain("unknown:");
  });

  it("ignores non-text blocks in textFromContent (image/toolCall)", () => {
    // textFromContent returns "" for non-text blocks (image, toolCall).
    const entries = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "x",
        message: {
          role: "user",
          content: [{ type: "image", url: "x" }],
        },
      },
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    // No text content → nothing added to trustedIntent
    expect(result.trustedIntent.length).toBe(0);
  });

  it("strips non-message entries (thinking_level_change, model_change)", () => {
    const entries = [
      { type: "thinking_level_change", id: "1", parentId: null, timestamp: "x", level: "high" },
      { type: "model_change", id: "2", parentId: "1", timestamp: "x", model: "gpt-4" },
      makeMessage("user", "hello"),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent).toContain("hello");
    expect(result.strippedCount).toBe(2);
  });

  it("skips undefined entries in the array", () => {
    // buildContextEntries should always return defined entries, but the guard
    // must handle an undefined hole without crashing.
    const entries = [undefined, makeMessage("user", "hello"), undefined];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent).toContain("hello");
  });

  it("skips compaction entries with an empty summary", () => {
    const entries = [makeCompaction(""), makeMessage("user", "after compact")];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    // Empty summary → not added to trustedIntent, but not counted as stripped either
    expect(result.trustedIntent).toContain("after compact");
    expect(result.trustedIntent.some((s) => s === "")).toBe(false);
  });

  it("redacts secrets in trusted intent (user message, ask_user_question, compaction)", () => {
    // Secrets in trusted intent must be redacted in the stripper so the
    // StrippedTranscript object is safe to log and the contextHash is based
    // on redacted text. Covers all three trustedIntent sources.
    const entries = [
      makeMessage(
        "user",
        "deploy with sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234",
      ),
      makeToolResult("ask_user_question", "chose AKIAABCDEFGHIJKLMNOP"),
      makeCompaction("summary with password=hunter2supersecretvalue"),
    ];
    const sm = { buildContextEntries: () => entries as unknown as SessionEntry[] };
    const result = stripTranscript(sm, opts);
    expect(result.trustedIntent.some((s) => s.includes("sk-ant-"))).toBe(false);
    expect(result.trustedIntent.some((s) => s.includes("AKIAABCDEFGHIJKLMNOP"))).toBe(false);
    expect(result.trustedIntent.some((s) => s.includes("hunter2"))).toBe(false);
    expect(result.trustedIntent.some((s) => s.includes("[REDACTED]"))).toBe(true);
  });
});
