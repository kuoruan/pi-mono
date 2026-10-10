/**
 * The write-details channel: the tool_call/tool_result pair that captures
 * the old/new diff the SDK's write tool does not carry. The self-check is
 * the contract under test — details are produced ONLY when the file that
 * landed is exactly the content the call supplied, so a sibling write, a
 * changed argument, an aborted call, or a blocked one degrades to no
 * details (the renderer then falls back to the plain line).
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCurrentKitForTest, setCurrentKit } from "#src/render/current-kit.ts";
import { createRenderKit } from "#src/render/kit.ts";
import {
  registerWriteDetailsChannel,
  resetWriteDetailsChannelForTest,
} from "#src/render/write-details-channel.ts";
import { vol, writeFile } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

const CWD = "/wd-project";
const AGENT = "/wd-agent";

/** A captured event handler. */
type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

/**
 * A fake `pi` whose registry holds builtins (and any staged foreign names).
 *
 * @param foreign - Foreign-owned names (source "local").
 * @returns The API and a fire helper.
 */
function makePi(foreign: string[] = []) {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getAllTools: () => [
      ...foreign.map((name) => ({ name, sourceInfo: { source: "local", path: "<foreign>" } })),
      ...["write", "edit", "bash", "powershell", "grep", "ls", "find", "read"].map((name) => ({
        name,
        sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
      })),
    ],
    getCommands: () => [{ name: "pigment" }],
  };
  const fire = (event: string, payload: Record<string, unknown>): unknown[] =>
    (handlers.get(event) ?? []).map((handler) => handler(payload));
  return { api, fire };
}

/**
 * The `tool_call` payload for a write.
 *
 * @param id - The tool call id.
 * @param input - The write tool input.
 * @returns The event payload.
 */
function callPayload(id: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_call", toolName: "write", toolCallId: id, input };
}

/**
 * The `tool_result` payload for a write.
 *
 * @param id - The tool call id.
 * @param input - The write tool input.
 * @param isError - Whether the call failed.
 * @returns The event payload.
 */
function resultPayload(
  id: string,
  input: Record<string, unknown>,
  isError = false,
): Record<string, unknown> {
  return { type: "tool_result", toolName: "write", toolCallId: id, input, content: [], isError };
}

beforeEach(async () => {
  vol.reset();
  vol.mkdirSync(CWD, { recursive: true });
  vol.mkdirSync(AGENT, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = AGENT;
  resetWriteDetailsChannelForTest();
  resetCurrentKitForTest();
  setCurrentKit(await createRenderKit({ cwd: CWD, agentDir: AGENT }));
});

afterEach(() => {
  resetWriteDetailsChannelForTest();
  resetCurrentKitForTest();
  delete process.env.PI_CODING_AGENT_DIR;
  vol.reset();
});

describe("write details channel", () => {
  it("captures a changed-file diff when the landed content matches", () => {
    writeFile(join(CWD, "a.ts"), "const a = 1;\n");
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    const input = { path: "a.ts", content: "const a = 2;\n" };
    fire("tool_call", callPayload("c1", input));
    writeFile(join(CWD, "a.ts"), "const a = 2;\n");
    const [result] = fire("tool_result", resultPayload("c1", input)) as Array<{
      details?: { kind?: string };
    }>;
    expect(result?.details?.kind).toBe("diff");
  });

  it("captures a new file", () => {
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    const input = { path: "new.ts", content: "export const x = 1;\n" };
    fire("tool_call", callPayload("c2", input));
    writeFile(join(CWD, "new.ts"), "export const x = 1;\n");
    const [result] = fire("tool_result", resultPayload("c2", input)) as Array<{
      details?: { kind?: string };
    }>;
    expect(result?.details?.kind).toBe("new");
  });

  it("captures no-change", () => {
    writeFile(join(CWD, "same.ts"), "same\n");
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    const input = { path: "same.ts", content: "same\n" };
    fire("tool_call", callPayload("c3", input));
    const [result] = fire("tool_result", resultPayload("c3", input)) as Array<{
      details?: { kind?: string };
    }>;
    expect(result?.details?.kind).toBe("noChange");
  });

  it("drops details when the disk content differs from what the call supplied (changed args)", () => {
    writeFile(join(CWD, "race.ts"), "old\n");
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    const input = { path: "race.ts", content: "expected\n" };
    fire("tool_call", callPayload("c4", input));
    // A sibling/rewritten write landed a different body.
    writeFile(join(CWD, "race.ts"), "something else\n");
    const [result] = fire("tool_result", resultPayload("c4", input));
    expect(result).toBeUndefined();
  });

  it("drops details on an error result", () => {
    writeFile(join(CWD, "err.ts"), "old\n");
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    const input = { path: "err.ts", content: "new\n" };
    fire("tool_call", callPayload("c5", input));
    writeFile(join(CWD, "err.ts"), "new\n");
    const [result] = fire("tool_result", resultPayload("c5", input, true));
    expect(result).toBeUndefined();
  });

  it("drops details for a blocked call (tool_call with no tool_result, or no stash)", () => {
    writeFile(join(CWD, "blocked.ts"), "old\n");
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    // No tool_call ever fired (blocked before execution): a stray
    // tool_result must not invent details.
    const [result] = fire("tool_result", resultPayload("c6", { path: "blocked.ts", content: "x" }));
    expect(result).toBeUndefined();
  });

  it("never throws out of tool_call — a registry fault must not block the write", () => {
    // pi's emitToolCall has no guard, and the SDK wraps a handler throw as
    // "Extension failed, blocking execution" — so a rendering-side fault
    // here would stop the model's write from ever running. The handler must
    // swallow every throw and leave the caller with nothing to block on.
    writeFile(join(CWD, "boom.ts"), "old\n");
    const { api, fire } = makePi();
    (api as { getAllTools: () => unknown }).getAllTools = () => {
      throw new Error("registry exploded");
    };
    registerWriteDetailsChannel(api as never);
    const input = { path: "boom.ts", content: "new\n" };
    expect(() => fire("tool_call", callPayload("c7", input))).not.toThrow();
    // The fault dropped the stash, so the paired result invents nothing.
    const [result] = fire("tool_result", resultPayload("c7", input));
    expect(result).toBeUndefined();
  });

  it("stops stashing once write is disabled", async () => {
    setCurrentKit(
      await createRenderKit({ cwd: CWD, agentDir: AGENT, config: { disabledTools: ["write"] } }),
    );
    writeFile(join(CWD, "disabled.ts"), "old\n");
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    const input = { path: "disabled.ts", content: "new\n" };
    fire("tool_call", callPayload("c7", input));
    writeFile(join(CWD, "disabled.ts"), "new\n");
    const [result] = fire("tool_result", resultPayload("c7", input));
    expect(result).toBeUndefined();
  });

  it("stops stashing when another extension owns write", () => {
    writeFile(join(CWD, "foreign.ts"), "old\n");
    const { api, fire } = makePi(["write"]);
    registerWriteDetailsChannel(api as never);
    const input = { path: "foreign.ts", content: "new\n" };
    fire("tool_call", callPayload("c8", input));
    writeFile(join(CWD, "foreign.ts"), "new\n");
    const [result] = fire("tool_result", resultPayload("c8", input));
    expect(result).toBeUndefined();
  });

  it("drops the stash on a session boundary between tool_call and tool_result", () => {
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    // The pre-read lands, then the session ends before the tool_result
    // fires: each boundary must drop the stash, so a call straddling
    // either edge never leaks details into the next session.
    fire("tool_call", callPayload("c9", { path: "boundary-a.ts", content: "one\n" }));
    writeFile(join(CWD, "boundary-a.ts"), "one\n");
    fire("session_shutdown", {});
    const [afterShutdown] = fire(
      "tool_result",
      resultPayload("c9", { path: "boundary-a.ts", content: "one\n" }),
    );
    expect(afterShutdown).toBeUndefined();

    fire("tool_call", callPayload("c10", { path: "boundary-b.ts", content: "two\n" }));
    writeFile(join(CWD, "boundary-b.ts"), "two\n");
    fire("session_start", {});
    const [afterStart] = fire(
      "tool_result",
      resultPayload("c10", { path: "boundary-b.ts", content: "two\n" }),
    );
    expect(afterStart).toBeUndefined();
  });

  it("evicts the oldest stash once 16 in-flight calls are buffered", () => {
    const { api, fire } = makePi();
    registerWriteDetailsChannel(api as never);
    // 16 in-flight writes (no tool_result yet), each landed on disk.
    const ids = Array.from({ length: 16 }, (_, i) => `c-fifo-${i}`);
    for (const [i, id] of ids.entries()) {
      fire("tool_call", callPayload(id, { path: `fifo-${i}.ts`, content: `content-${i}\n` }));
      writeFile(join(CWD, `fifo-${i}.ts`), `content-${i}\n`);
    }
    // The 17th distinct id pushes the oldest entry (c-fifo-0) out.
    fire("tool_call", callPayload("c-fifo-16", { path: "fifo-16.ts", content: "content-16\n" }));
    writeFile(join(CWD, "fifo-16.ts"), "content-16\n");

    // The evicted id has no stash left, so its result produces nothing...
    const [evicted] = fire(
      "tool_result",
      resultPayload("c-fifo-0", { path: "fifo-0.ts", content: "content-0\n" }),
    );
    expect(evicted).toBeUndefined();
    // ...while the most recent call still resolves to a real payload.
    const [kept] = fire(
      "tool_result",
      resultPayload("c-fifo-16", { path: "fifo-16.ts", content: "content-16\n" }),
    ) as Array<{
      details?: { kind?: string };
    }>;
    expect(kept?.details?.kind).toBe("new");
  });
});
