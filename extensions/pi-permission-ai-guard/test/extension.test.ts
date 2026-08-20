/**
 * Extension wiring tests: session_start → permissions:ready →
 * session_shutdown → session_tree event dispatch into the SessionLifecycle
 * and RuntimeSettings modules, idempotency, and state cleanup. The
 * lifecycle's notify bridge, the settings surface, and the persistence
 * store have their own direct test files.
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
import { configSchema } from "#src/config-schema.ts";
import type { ReviewPipelineDeps } from "#src/review-pipeline.ts";
import { SETTING_ENTRY_TYPE } from "#src/session-settings-store.ts";

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
  const commands = new Map<
    string,
    {
      description?: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) =>
        | { value: string; label: string }[]
        | null
        | Promise<{ value: string; label: string }[] | null>;
      handler: (args: string, ctx: any) => Promise<void>;
    }
  >();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => void }>();

  return {
    listeners,
    eventListeners,
    commands,
    shortcuts,
    // ExtensionAPI shape
    on: vi.fn<(event: string, handler: (...args: any[]) => void) => void>((event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    }),
    registerCommand: vi.fn<
      (
        name: string,
        options: { description?: string; handler: (args: string, ctx: any) => Promise<void> },
      ) => void
    >((name, options) => {
      commands.set(name, options);
    }),
    registerShortcut: vi.fn<
      (shortcut: string, options: { description?: string; handler: (ctx: any) => void }) => void
    >((shortcut, options) => {
      shortcuts.set(shortcut, options);
    }),
    appendEntry: vi.fn<(customType: string, data?: unknown) => void>(),
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

function makeSessionCtx(
  overrides: Partial<{
    cwd: string;
    trusted: boolean;
    sessionManager: Record<string, unknown>;
    ui: Record<string, unknown>;
  }> = {},
) {
  return {
    cwd: overrides.cwd ?? "/project",
    isProjectTrusted: () => overrides.trusted ?? true,
    modelRegistry: {
      find: () => undefined,
      getProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [] as never[],
      ...overrides.sessionManager,
    },
    ui: { notify: vi.fn<() => void>(), setStatus: vi.fn<() => void>(), ...overrides.ui },
  };
}

/**
 * Build a custom ai-guard-setting session entry for restore fixtures.
 *
 * @param mode - The persisted mode value (string, or null for reset).
 * @param parentId - The entry's parentId (chain continuation for walk fixtures).
 * @param id - The entry id.
 * @returns A minimal custom-entry object shaped like a persisted entry.
 */
function settingEntry(mode: string | null, parentId: string | null = null, id = "e1") {
  return { type: "custom", customType: SETTING_ENTRY_TYPE, data: { mode }, parentId, id };
}

/**
 * UI context mock for command/shortcut handlers (notify, setStatus, select).
 *
 * @returns A mock `ctx.ui` with spies for the three methods the handlers use.
 */
function makeUiCtx() {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn<(message: string, type?: "info" | "warning" | "error") => void>(),
      setStatus: vi.fn<(key: string, text: string | undefined) => void>(),
      select: vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(
        async () => undefined,
      ),
    },
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

  it("a repeated session_start without shutdown re-points the live pipeline at the new session", async () => {
    // The observable M1 regression: pi re-dispatches session_start on
    // reload/fork without an intervening shutdown. The LIVE registration
    // must track the new session — the previous session's override is
    // reset, per-session breaker/cache are fresh (no leak), and runtime
    // writes after the re-dispatch land on the object the live pipeline
    // reads.
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline, calls } = makeStubPipeline();

    createAiGuardExtension(pi as any, { createPipeline });

    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(1);
    const live = calls[0]!;

    // A session override reaches the pipeline's overrides object.
    await pi.commands.get("ai-guard")!.handler("mode manual", makeUiCtx());
    expect(live.overrides.mode).toBe("manual");

    // Re-dispatched session_start (no shutdown in between).
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mockDispose).toHaveBeenCalledTimes(1); // stale registration disposed
    expect(mockRegisterAuthorizer).toHaveBeenCalledTimes(2);
    // The overrides object keeps its identity (every pipeline generation's
    // captured reference stays valid) but was reset in place: the new
    // session starts from the config default.
    expect(calls[1]!.overrides).toBe(live.overrides);
    expect(live.overrides.mode).toBeUndefined();
    // Per-session state does not leak across sessions.
    expect(calls[1]!.circuitBreaker).not.toBe(live.circuitBreaker);
    expect(calls[1]!.verdictCache).not.toBe(live.verdictCache);

    // A runtime write after the re-dispatch reaches the live pipeline.
    await pi.commands.get("ai-guard")!.handler("mode auto", makeUiCtx());
    expect(calls[1]!.overrides.mode).toBe("auto");
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
    const config = configSchema.parse({ provider: "test", model: "test" });
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

    // session_shutdown → dispose + reset + footer status cleared
    pi.fire("session_shutdown", {}, makeSessionCtx());
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

    expect(() => pi.fire("session_shutdown", {}, makeSessionCtx())).not.toThrow();
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
        mode: "default" as const,
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

  it("silently skips 'already registered' (subagent re-registration)", () => {
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

    // Benign duplicate (subagent) → silently skipped, no log output.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();

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

describe("createAiGuardExtension — /ai-guard command + ctrl+alt+g shortcut", () => {
  /**
   * Create the extension with a stub pipeline and fire session_start.
   *
   * @returns The mock pi (with recorded commands/shortcuts) and the captured pipeline deps.
   */
  function setup() {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline, calls } = makeStubPipeline();
    createAiGuardExtension(pi as any, { createPipeline });
    pi.fire("session_start", {}, makeSessionCtx());
    return { pi, calls };
  }

  it("registers the /ai-guard command and the ctrl+alt+g shortcut", () => {
    const { pi } = setup();
    expect(pi.commands.has("ai-guard")).toBe(true);
    expect(pi.shortcuts.has("ctrl+alt+g")).toBe(true);
  });

  it("/ai-guard mode <value> mutates the live pipeline's session overrides", async () => {
    const { pi, calls } = setup();
    const deps = calls[0]!;
    expect(deps.overrides.mode).toBeUndefined();

    const ctx = makeUiCtx();
    await pi.commands.get("ai-guard")!.handler("mode manual", ctx);

    // The pipeline closed over this exact object at registration — the
    // override takes effect without re-registering the authorizer.
    expect(deps.overrides.mode).toBe("manual");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "manual (session)");
  });
});

describe("createAiGuardExtension — mode session persistence", () => {
  /**
   * Create the extension with a stub pipeline and fire session_start.
   *
   * @param sessionCtxOverrides - Extra makeSessionCtx overrides (sessionManager fixtures, ui).
   * @returns The mock pi (with the appendEntry spy) and the captured pipeline deps.
   */
  function setup(sessionCtxOverrides: Parameters<typeof makeSessionCtx>[0] = {}) {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline, calls } = makeStubPipeline();
    createAiGuardExtension(pi as any, { createPipeline });
    pi.fire("session_start", {}, makeSessionCtx(sessionCtxOverrides));
    return { pi, calls };
  }

  it("session_start restores the override from the leaf entry and shows the footer status", () => {
    const setStatus = vi.fn<() => void>();
    const { calls } = setup({
      sessionManager: { getBranch: () => [settingEntry("auto")] },
      ui: { setStatus },
    });
    // The restored override is live in the deps the pipeline closed over.
    expect(calls[0]!.overrides.mode).toBe("auto");
    expect(setStatus).toHaveBeenCalledWith("ai-guard", "auto (session)");
  });

  it("session_start clears the footer for the default mode (no baseline noise)", () => {
    const setStatus = vi.fn<() => void>();
    setup({ ui: { setStatus } });
    expect(setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("session_shutdown clears the footer status", () => {
    const setStatus = vi.fn<() => void>();
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    createAiGuardExtension(pi as any, { createPipeline: makeStubPipeline().createPipeline });

    pi.fire("session_start", {}, makeSessionCtx({ ui: { setStatus } }));
    expect(setStatus).toHaveBeenCalledWith("ai-guard", undefined);

    pi.fire("session_shutdown", {}, makeSessionCtx({ ui: { setStatus } }));
    expect(setStatus).toHaveBeenLastCalledWith("ai-guard", undefined);
  });
});

describe("createAiGuardExtension — official-pattern follow-ups", () => {
  /**
   * Create the extension with a stub pipeline and fire session_start.
   *
   * @param sessionCtxOverrides - Extra makeSessionCtx overrides (sessionManager fixtures, ui).
   * @returns The mock pi (with recorded commands/shortcuts) and the captured pipeline deps.
   */
  function setup(sessionCtxOverrides: Parameters<typeof makeSessionCtx>[0] = {}) {
    const pi = makeMockPi();
    const fakeService = { registerAuthorizer: mockRegisterAuthorizer };
    mockGetPermissionsService.mockReturnValue(fakeService);
    const { createPipeline, calls } = makeStubPipeline();
    createAiGuardExtension(pi as any, { createPipeline });
    pi.fire("session_start", {}, makeSessionCtx(sessionCtxOverrides));
    return { pi, calls };
  }

  it("session_tree re-derives the override from the new active branch", () => {
    const setStatus = vi.fn<() => void>();
    const { pi, calls } = setup({
      sessionManager: { getBranch: () => [settingEntry("manual")] },
      ui: { setStatus },
    });
    expect(calls[0]!.overrides.mode).toBe("manual");

    // Rewind past the setting entry: the new active branch has none.
    const treeStatus = vi.fn<() => void>();
    pi.fire(
      "session_tree",
      {},
      makeSessionCtx({ sessionManager: { getBranch: () => [] }, ui: { setStatus: treeStatus } }),
    );

    expect(calls[0]!.overrides.mode).toBeUndefined();
    expect(treeStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("session_tree with a setting entry on the new branch restores it", () => {
    const { pi, calls } = setup();
    expect(calls[0]!.overrides.mode).toBeUndefined();

    pi.fire(
      "session_tree",
      {},
      makeSessionCtx({
        sessionManager: { getBranch: () => [settingEntry("auto")] },
      }),
    );

    expect(calls[0]!.overrides.mode).toBe("auto");
  });
});
