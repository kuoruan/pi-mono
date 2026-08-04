/**
 * Extension lifecycle tests: session_start → permissions:ready →
 * session_shutdown wiring, idempotency, and state cleanup.
 */

import { describe, expect, it, vi } from "vitest";

const mockDispose = vi.fn<() => void>();
const mockRegisterAuthorizer = vi.fn<(name: string, authorize: unknown) => () => void>(
  () => mockDispose,
);
const mockGetPermissionsService = vi.fn<() => unknown>();

vi.mock("@gotgenes/pi-permission-system", () => ({
  getPermissionsService: () => mockGetPermissionsService(),
  PERMISSIONS_READY_CHANNEL: "permissions:ready",
}));

// Hoisted so the createAiGuardExtension import triggers the mock resolution.
const { createAiGuardExtension } = await import("#src/extension.ts");
import type { LoadConfigResult } from "#src/config-loader.ts";
import type { ReviewPipelineDeps } from "#src/review-pipeline.ts";

/**
 * A stub authorizer factory that records the deps it was called with.
 * Lets lifecycle tests run without resolving the model stack.
 *
 * @returns A stub pipeline factory, recorded calls, and the stub authorize function.
 */
function makeStubPipeline() {
  const calls: ReviewPipelineDeps[] = [];
  const authorize = vi.fn<() => Promise<{ kind: "defer" }>>(async () => ({ kind: "defer" }));
  const createPipeline = vi.fn<(deps: ReviewPipelineDeps) => typeof authorize>((deps) => {
    calls.push(deps);
    return authorize;
  });
  return { createPipeline, calls, authorize };
}

/**
 * Minimal ExtensionAPI mock that records listeners and exposes fire helpers.
 *
 * @returns A mock ExtensionAPI with recorded listeners and fire helpers.
 */
function makeMockPi() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const eventListeners = new Map<string, Array<(...args: any[]) => void>>();

  return {
    listeners,
    eventListeners,
    // ExtensionAPI shape
    on: vi.fn<(event: string, handler: (...args: any[]) => void) => void>((event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    }),
    events: {
      on: vi.fn<(channel: string, handler: (...args: any[]) => void) => () => void>(
        (channel, handler) => {
          const list = eventListeners.get(channel) ?? [];
          list.push(handler);
          eventListeners.set(channel, list);
          return () => {
            const idx = list.indexOf(handler);
            if (idx >= 0) list.splice(idx, 1);
          };
        },
      ),
    },
    /**
     * Fire a lifecycle event (session_start, session_shutdown).
     *
     * @param event - The lifecycle event name.
     * @param args - Event arguments forwarded to listeners.
     */
    fire(event: string, ...args: any[]): void {
      for (const h of listeners.get(event) ?? []) h(...args);
    },
    /**
     * Fire an event-channel event (permissions:ready).
     *
     * @param channel - The event channel name.
     * @param args - Event arguments forwarded to listeners.
     */
    fireEvent(channel: string, ...args: any[]): void {
      for (const h of eventListeners.get(channel) ?? []) h(...args);
    },
  };
}

function makeSessionCtx(overrides: Partial<{ cwd: string; trusted: boolean }> = {}) {
  return {
    cwd: overrides.cwd ?? "/project",
    isProjectTrusted: () => overrides.trusted ?? true,
    modelRegistry: {
      find: () => undefined,
      getProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: { buildContextEntries: () => [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPermissionsService.mockReturnValue(undefined);
});

describe("createAiGuardExtension lifecycle", () => {
  it("registers authorizer when session_start fires and permissions service is available", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    // Before session_start: no registration
    expect(mockRegisterAuthorizer).not.toHaveBeenCalled();

    // session_start → register (the service is already available).
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);
    expect(mockRegisterAuthorizer).toHaveBeenCalledWith("ai-guard", expect.any(Function));
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it("registers when permissions service becomes available after session_start", () => {
    // session_start fires before the permission service is published:
    // tryRegister finds no service and skips. permissions:ready then
    // fires and completes registration.
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    // No service yet → session_start does not register.
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).not.toHaveBeenCalled();

    // Service published + permissions:ready → register.
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    pi.fireEvent("permissions:ready");
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("does not register when permissions service is unavailable", () => {
    const pi = makeMockPi();
    mockGetPermissionsService.mockReturnValue(undefined);
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });
    pi.fire("session_start", {}, makeSessionCtx());
    pi.fireEvent("permissions:ready");

    expect(mockRegisterAuthorizer).not.toHaveBeenCalled();
    expect(createPipeline).not.toHaveBeenCalled();
  });

  it("does not double-register on repeated session_start without shutdown", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);

    // Second session_start without shutdown: idempotency guard prevents
    // double registration.
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("re-registers on permissions:ready after previous registration", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    // session_start → register
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);

    // permissions:ready → dispose old + re-register
    pi.fireEvent("permissions:ready");
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(2);
  });

  it("preserves session state across permissions:ready re-registration", () => {
    // The session object (config, circuitBreaker, verdictCache) must survive
    // permissions:ready — only the authorizer link is re-registered. If the
    // session were rebuilt, loadConfig would be called again (resetting
    // breaker counts and cache entries).
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();

    let loadCalls = 0;
    const config = {
      provider: "test",
      model: "test",
      surfaces: ["bash"],
      transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
      circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" as const },
      cache: { maxEntries: 0 },
      timeoutMs: 10000,
      reasoning: "off" as const,
      instructions: null,
    };
    createAiGuardExtension(pi as any, {
      createPipeline,
      loadConfig: () => {
        loadCalls++;
        return { config, issues: [] };
      },
    });

    pi.fire("session_start", {}, makeSessionCtx());
    expect(loadCalls).toBe(1);

    // permissions:ready re-registers the authorizer but must NOT rebuild
    // the session — loadConfig stays at 1 call.
    pi.fireEvent("permissions:ready");
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(2);
    expect(loadCalls).toBe(1); // session not rebuilt → breaker/cache preserved
  });

  it("permissions:ready is a no-op when not yet registered and no session", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    // permissions:ready before session_start → no session → no registration.
    pi.fireEvent("permissions:ready");
    expect(mockRegisterAuthorizer).not.toHaveBeenCalled();
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it("session_shutdown disposes and resets all state", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    // session_start → register
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);

    // session_shutdown → dispose + reset
    pi.fire("session_shutdown");
    expect(mockDispose).toHaveBeenCalledTimes(1);

    // After shutdown, a new session_start should register again
    mockRegisterAuthorizer.mockClear();
    mockDispose.mockClear();
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("session_shutdown does not throw when no registration was active", () => {
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();
    createAiGuardExtension(pi as any, { createPipeline });

    expect(() => pi.fire("session_shutdown")).not.toThrow();
  });

  it("subscribes to permissions:ready channel on construction", () => {
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();
    createAiGuardExtension(pi as any, { createPipeline });
    expect(pi.events.on).toHaveBeenCalledWith("permissions:ready", expect.any(Function));
  });

  it("subscribes to session_start and session_shutdown on construction", () => {
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();
    createAiGuardExtension(pi as any, { createPipeline });
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("config load failures are warned and block registration", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    createAiGuardExtension(pi as any, {
      createPipeline,
      loadConfig: () => ({ config: undefined, issues: [{ path: "$", message: "bad config" }] }),
    });

    pi.fire("session_start", {}, makeSessionCtx());

    // Config is undefined → authorizer not registered (no config = no review)
    expect(mockRegisterAuthorizer).not.toHaveBeenCalled();
    expect(createPipeline).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bad config"));

    warnSpy.mockRestore();
  });

  it("passes cwd and trustedProject from session context to config loader", () => {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline } = makeStubPipeline();
    const loadConfig = vi.fn<(cwd: string, trusted: boolean) => LoadConfigResult>(() => ({
      config: {
        provider: "test",
        model: "test",
        surfaces: ["bash"],
        transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
        circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" as const },
        cache: { maxEntries: 0 },
        timeoutMs: 10000,
        reasoning: "off" as const,
        instructions: null,
      },
      issues: [],
    }));

    createAiGuardExtension(pi as any, { createPipeline, loadConfig });

    pi.fire("session_start", {}, makeSessionCtx({ cwd: "/my-project", trusted: false }));

    expect(loadConfig).toHaveBeenCalledWith("/my-project", false);
  });

  it("handles registerAuthorizer throwing without crashing", () => {
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingRegister = vi.fn<(name: string, authorize: unknown) => never>(() => {
      throw new Error("registration failed");
    });
    const fakeService = { registerAuthorizer: throwingRegister };
    mockGetPermissionsService.mockReturnValue(fakeService);

    createAiGuardExtension(pi as any, { createPipeline });

    // session_start calls tryRegister which calls registerAuthorizer.
    // The throw must not propagate — it's caught and warned.
    expect(() => pi.fire("session_start", {}, makeSessionCtx())).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to register"));

    warnSpy.mockRestore();
  });

  it("downgrades 'already registered' to debug (subagent re-registration)", () => {
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // The exact message AuthorizerRegistry.register throws.
    const duplicateRegister = vi.fn<(name: string, authorize: unknown) => never>(() => {
      throw new Error("An authorizer is already registered for 'ai-guard'.");
    });
    const fakeService = { registerAuthorizer: duplicateRegister };
    mockGetPermissionsService.mockReturnValue(fakeService);

    createAiGuardExtension(pi as any, { createPipeline });

    pi.fire("session_start", {}, makeSessionCtx());

    // Benign duplicate (subagent) → debug, not warn.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Failed to register"));
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Authorizer link already registered"),
    );

    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("does not downgrade a similar-but-different 'already registered' error", () => {
    const pi = makeMockPi();
    const { createPipeline } = makeStubPipeline();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    // Different link name in the message — must NOT match the downgrade.
    const similarRegister = vi.fn<(name: string, authorize: unknown) => never>(() => {
      throw new Error("An authorizer is already registered for 'other-link'.");
    });
    const fakeService = { registerAuthorizer: similarRegister };
    mockGetPermissionsService.mockReturnValue(fakeService);

    createAiGuardExtension(pi as any, { createPipeline });

    pi.fire("session_start", {}, makeSessionCtx());

    // Different name → stays a warning, not downgraded.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to register"));
    expect(debugSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
