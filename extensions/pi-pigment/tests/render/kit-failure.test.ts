/**
 * The kit-build fail-safe: a session_start whose kit build throws must
 * leave the current-kit slot empty, so the resolver hands every name to
 * the next renderer (pi's built-ins) BY REFERENCE instead of decorating
 * with a stale or half-built session's kit — and the failure surfaces
 * through the documented issue channel (the TUI notification when one
 * exists).
 */

import type {
  ExtensionAPI,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPigmentExtension } from "#src/extension.ts";
import { currentKit, resetCurrentKitForTest, setCurrentKit } from "#src/render/current-kit.ts";
import type { createRenderKit as CreateRenderKit } from "#src/render/kit.ts";

vi.mock("#src/render/kit.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRenderKit: (async () => {
      throw new Error("kit-build exploded");
    }) as typeof CreateRenderKit,
  };
});

/** The eight names the resolver decorates with no foreign occupancy. */
const NAMES = ["write", "edit", "bash", "powershell", "grep", "ls", "find", "read"];

/** The built-in renderer triple a yield must hand back by reference. */
const ORIG: ToolRenderers = {
  renderShell: "default",
  renderCall: (() => ({ kind: "builtin-call" })) as never,
  renderResult: (() => ({ kind: "builtin-result" })) as never,
};

/** A captured extension event handler. */
type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

/**
 * Drive the extension's session_start over a kit build that throws, and
 * return the resolver plus the UI-issue spy.
 *
 * @returns The registered resolver and the notify spy.
 */
async function driveFailingSessionStart(): Promise<{
  resolver: ToolRendererResolver;
  notify: ReturnType<typeof vi.fn>;
  handlers: Map<string, Handler[]>;
}> {
  const notify = vi.fn<() => void>();
  const handlers = new Map<string, Handler[]>();
  let resolver: ToolRendererResolver | undefined;
  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: () => {},
    registerToolRenderer: (r: ToolRendererResolver) => {
      resolver = r;
    },
    registerCommand: () => {},
    getAllTools: () =>
      NAMES.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
    getCommands: () => [{ name: "pigment" }],
  };
  createPigmentExtension(api as unknown as ExtensionAPI);
  const sessionStartHandlers = handlers.get("session_start") ?? [];
  if (sessionStartHandlers.length === 0) throw new Error("session_start handler not registered");
  // pi fires every registered session_start handler in order (the channel's
  // clearStashes first, then the extension's kit build).
  for (const handler of sessionStartHandlers) {
    await handler(
      { type: "session_start", reason: "startup" },
      {
        cwd: "/kit-failure-project",
        isProjectTrusted: () => true,
        hasUI: true,
        ui: { notify },
      },
    );
  }
  if (resolver === undefined) throw new Error("resolver not registered");
  return { resolver, notify, handlers };
}

/**
 * Fire every handler registered for `event`, in order (pi awaits each).
 *
 * @param handlers - The captured handler map.
 * @param event - The event name to fire.
 */
async function fireEvent(handlers: Map<string, Handler[]>, event: string): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler({ type: event });
}

beforeEach(() => {
  resetCurrentKitForTest();
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("kit-build fail-safe", () => {
  it("clears the slot and yields every name when the kit build throws", async () => {
    // A prior session's kit must not survive the failed rebuild.
    setCurrentKit({ cwd: "/prior-session", canDecorate: () => true } as never);
    const { resolver, notify } = await driveFailingSessionStart();

    expect(currentKit()).toBeUndefined();
    // The failure surfaces through the issue channel (ui.notify).
    expect(notify).toHaveBeenCalledWith("[pi-pigment] kit-build exploded", "warning");
    // With the slot empty the resolver falls through to next() for every name.
    for (const name of NAMES) expect(resolver(name, () => ORIG)).toBe(ORIG);
  });

  it("clears the slot on session_shutdown — the other boundary", async () => {
    const { handlers } = await driveFailingSessionStart();
    // A live session's kit, as a successful build would have published it.
    setCurrentKit({ cwd: "/live-session", canDecorate: () => true } as never);
    expect(currentKit()).toBeDefined();
    await fireEvent(handlers, "session_shutdown");
    expect(currentKit()).toBeUndefined();
  });
});
