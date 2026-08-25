/**
 * SessionLifecycle direct tests: session identity (v27 keyed service
 * locator), the register-once-per-session guard, and the notify bridge
 * (authorize-time escalation messages through the stored event ctx) with
 * its failure semantics. Session/rebuild mechanics are also covered
 * through the extension surface in extension.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

import { configSchema } from "#src/config-schema.ts";
import type { ReviewPipelineDeps } from "#src/review-pipeline.ts";
import { SessionLifecycle, readSessionId } from "#src/session-lifecycle.ts";
import type { SessionSeed } from "#src/session-lifecycle.ts";

// vi.mock is hoisted ABOVE the static imports above, so the mock factory
// may only close over vi.hoisted() bindings — the spies live there.
const mocks = vi.hoisted(() => ({
  registerAuthorizer: vi.fn<(name: string, authorize: unknown) => () => void>(() => () => {}),
  getPermissionsService: vi.fn<(sessionId: string) => unknown>(),
}));

vi.mock("@gotgenes/pi-permission-system", () => ({
  getPermissionsService: (sessionId: string) => mocks.getPermissionsService(sessionId),
  PERMISSIONS_READY_CHANNEL: "permissions:ready",
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPermissionsService.mockReturnValue({
    registerAuthorizer: mocks.registerAuthorizer,
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
 * A seed over {@link makeSeed} defaults: session manager reporting id
 * "s1", minimal config.
 *
 * @param overrides - Seed fields to replace.
 * @returns A full SessionSeed.
 */
function makeSeed(overrides: Partial<SessionSeed> = {}): SessionSeed {
  return {
    config: configSchema.parse({ provider: "test", model: "test" }),
    registry: {
      find: () => undefined,
      getProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }) as never,
    },
    sessionManager: { getSessionId: () => "s1", buildContextEntries: () => [] },
    cwd: "/project",
    ctx: makeCtx(vi.fn<() => void>()) as never,
    ...overrides,
  };
}

/**
 * A session ctx carrying a notify spy.
 *
 * @param notify - The notify function the ctx's ui exposes.
 * @returns A minimal event ctx.
 */
function makeCtx(notify: (message: string, level?: string) => void) {
  return { ui: { notify } };
}

describe("SessionLifecycle — session identity + registration guard", () => {
  it("registers the authorizer on the session's own keyed service", () => {
    const { lifecycle, calls } = makeLifecycle();
    lifecycle.onSessionStart(makeSeed());
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("s1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("adopts the ready payload's session id when the session_start self-read found none", () => {
    const { lifecycle, calls } = makeLifecycle();
    lifecycle.onSessionStart(
      makeSeed({ sessionManager: { getSessionId: () => "", buildContextEntries: () => [] } }),
    );
    // Self-read (the fallback source) found nothing → skip for now.
    expect(mocks.getPermissionsService).not.toHaveBeenCalled();
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);

    // The official source — the ready payload — carries the id → adopt and
    // register. This is the case the old code could never recover from
    // (the seed was read once and a null stayed null forever).
    mocks.getPermissionsService.mockClear();
    lifecycle.onPermissionsReady({ sessionId: "p1", adjudicatesLocally: false });
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("p1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("a null ready payload never clobbers a real seed id", () => {
    const { lifecycle } = makeLifecycle();
    mocks.getPermissionsService.mockReturnValue(undefined);
    lifecycle.onSessionStart(makeSeed());
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("s1");
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();

    // Service published + ready payload WITHOUT an id: the seed read
    // ("s1") survives — adoption only upgrades, never downgrades.
    mocks.getPermissionsService.mockReturnValue({
      registerAuthorizer: mocks.registerAuthorizer,
    });
    lifecycle.onPermissionsReady({ sessionId: null, adjudicatesLocally: false });
    expect(mocks.getPermissionsService).toHaveBeenCalledTimes(2);
    expect(mocks.getPermissionsService).toHaveBeenLastCalledWith("s1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("a session_start self-read replaces a ready payload id adopted earlier", () => {
    const { lifecycle } = makeLifecycle();
    // ready fires before the session_start handler ran (node activation
    // precedes it): the payload id is adopted BUT there is no session yet,
    // so nothing registers. The start read then refreshes the slot — both
    // read the same host getter, so they cannot genuinely disagree; the
    // pin documents the refresh semantics.
    lifecycle.onPermissionsReady({ sessionId: "p9", adjudicatesLocally: true });
    expect(mocks.getPermissionsService).not.toHaveBeenCalled(); // no session yet
    lifecycle.onSessionStart(makeSeed());
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("s1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("permissions:ready after registration is a no-op (register once per session)", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.onSessionStart(makeSeed());
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);

    // v27 re-emits ready (latch at the node's first before_agent_start):
    // the guard must NOT dispose and re-register.
    lifecycle.onPermissionsReady({ sessionId: "s1", adjudicatesLocally: true });
    expect(mocks.getPermissionsService).toHaveBeenCalledTimes(1);
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("permissions:ready completes registration when session_start found no service", () => {
    const { lifecycle, calls } = makeLifecycle();
    mocks.getPermissionsService.mockReturnValue(undefined);
    lifecycle.onSessionStart(makeSeed());
    expect(mocks.getPermissionsService).toHaveBeenCalledTimes(1);
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();

    // Service published → ready completes the registration.
    mocks.getPermissionsService.mockReturnValue({
      registerAuthorizer: mocks.registerAuthorizer,
    });
    lifecycle.onPermissionsReady({ sessionId: "s1", adjudicatesLocally: false });
    expect(mocks.getPermissionsService).toHaveBeenCalledTimes(2);
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("readSessionId reads the id, maps missing to null, and never throws", () => {
    expect(readSessionId({ getSessionId: () => "s9" } as never)).toBe("s9");
    expect(readSessionId({ getSessionId: () => "" } as never)).toBeNull();
    expect(
      readSessionId({
        getSessionId: () => {
          throw new Error("no such method");
        },
      } as never),
    ).toBeNull();
  });
});

describe("SessionLifecycle — notify bridge", () => {
  it("deps.notify routes through the ctx captured at session_start", async () => {
    const { lifecycle, calls } = makeLifecycle();
    const notify = vi.fn<() => void>();
    lifecycle.onSessionStart(makeSeed({ ctx: makeCtx(notify) as never }));
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
    expect(() =>
      lifecycle.onPermissionsReady({ sessionId: "s1", adjudicatesLocally: false }),
    ).not.toThrow();
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
    lifecycle.onSessionStart(makeSeed({ ctx: staleCtx as never }));

    // A lost escalation message is visible (manual mode's notify is the
    // only channel carrying the reviewer's reasoning), never silent —
    // and never takes the verdict path down with it.
    stale = true;
    expect(() => calls[0]!.notify!("x", "warning")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("escalation message lost: x"));
    warnSpy.mockRestore();
  });
});
