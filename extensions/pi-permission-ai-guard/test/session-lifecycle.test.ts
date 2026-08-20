/**
 * SessionLifecycle direct tests: the notify bridge (authorize-time
 * escalation messages through the stored event ctx) and its failure
 * semantics. Session/rebuild mechanics are covered through the extension
 * surface in extension.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

const mockRegisterAuthorizer = vi.fn<(name: string, authorize: unknown) => () => void>(
  () => () => {},
);
const mockGetPermissionsService = vi.fn<() => unknown>();

vi.mock("@gotgenes/pi-permission-system", () => ({
  getPermissionsService: () => mockGetPermissionsService(),
  PERMISSIONS_READY_CHANNEL: "permissions:ready",
}));

const { SessionLifecycle } = await import("#src/session-lifecycle.ts");
import { configSchema } from "#src/config-schema.ts";
import type { ReviewPipelineDeps } from "#src/review-pipeline.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPermissionsService.mockReturnValue({
    registerAuthorizer: mockRegisterAuthorizer,
  });
});

/**
 * Build a lifecycle whose pipeline deps are captured for inspection.
 *
 * @returns The lifecycle and the captured deps.
 */
function makeLifecycle() {
  const calls: ReviewPipelineDeps[] = [];
  const lifecycle = new SessionLifecycle({
    createPipeline: (deps) => {
      calls.push(deps);
      return async () => ({ kind: "defer" });
    },
    completeSimple: async () => {
      throw new Error("unused");
    },
  });
  return { lifecycle, calls };
}

/**
 * A session seed ctx carrying a notify spy.
 *
 * @param notify - The notify function the ctx's ui exposes.
 * @returns A minimal event ctx.
 */
function makeCtx(notify: (message: string, level?: string) => void) {
  return { ui: { notify } };
}

describe("SessionLifecycle — notify bridge", () => {
  it("deps.notify routes through the ctx captured at session_start", async () => {
    const { lifecycle, calls } = makeLifecycle();
    const notify = vi.fn<() => void>();
    lifecycle.onSessionStart({
      config: configSchema.parse({ provider: "test", model: "test" }),
      registry: {
        find: () => undefined,
        getProvider: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: false }) as never,
      },
      sessionManager: { buildContextEntries: () => [] },
      cwd: "/project",
      ctx: makeCtx(notify) as never,
    });
    expect(calls.length).toBe(1);

    // The pipeline's notify dep calls through the ctx stored on the
    // session (never destructured — the lazy getters stay intact).
    calls[0]!.notify!("reviewer denied this request", "warning");
    expect(notify).toHaveBeenCalledWith("reviewer denied this request", "warning");
  });

  it("deps.notify before any session is a no-op", async () => {
    const { lifecycle, calls } = makeLifecycle();
    // No onSessionStart: the pipeline is registered only with a session,
    // so a notify captured before one can never fire — the guard is the
    // object-level `session?.ctx` read.
    expect(calls.length).toBe(0);
    expect(() => lifecycle.onPermissionsReady()).not.toThrow();
  });

  it("deps.notify survives a disposed ctx and warns (best-effort, never throws)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lifecycle, calls } = makeLifecycle();

    // A ctx that goes stale AFTER session_start: the ui getter works while
    // the handler runs, then throws like pi's disposed-runner assertActive.
    let stale = false;
    const baseUi = { notify: vi.fn<() => void>() };
    const staleCtx = {
      ui: {
        get notify() {
          if (stale) throw new Error("extension context accessed after dispose");
          return baseUi.notify;
        },
      },
    };
    lifecycle.onSessionStart({
      config: configSchema.parse({ provider: "test", model: "test" }),
      registry: {
        find: () => undefined,
        getProvider: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: false }) as never,
      },
      sessionManager: { buildContextEntries: () => [] },
      cwd: "/project",
      ctx: staleCtx as never,
    });

    // A lost escalation message is visible (manual mode's notify is the
    // only channel carrying the reviewer's reasoning), never silent —
    // and never takes the verdict path down with it.
    stale = true;
    expect(() => calls[0]!.notify!("x", "warning")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("escalation message lost: x"));
    warnSpy.mockRestore();
  });
});
