/**
 * Extension wiring tests: session_start → permissions:ready →
 * session_shutdown → session_tree event dispatch into the SessionLifecycle
 * and RuntimeSettings modules, idempotency, and state cleanup. The
 * lifecycle's notify bridge, the settings surface, and the persistence
 * store have their own direct test files.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ConfigEnv, ConfigLayerTarget, LoadConfigResult } from "#src/config/config-layer.ts";
import { type AiGuardConfig, configSchema } from "#src/config/config-schema.ts";
import { createAiGuardExtension } from "#src/extension.ts";
import type { ReviewPipelineDeps } from "#src/review/review-pipeline.ts";
import type { CompletionItem } from "#src/session/runtime-settings.ts";
import { SETTING_ENTRY_TYPE } from "#src/session/session-settings-store.ts";

// vi.mock is hoisted ABOVE the static import above, so the mock factory
// may only close over vi.hoisted() bindings — the spies live there.
const mocks = vi.hoisted(() => {
  const dispose = vi.fn<() => void>();
  return {
    dispose,
    registerAuthorizer: vi.fn<(name: string, authorize: unknown) => () => void>(() => dispose),
    getPermissionsService: vi.fn<(sessionId: string) => unknown>(),
  };
});

vi.mock("@gotgenes/pi-permission-system", () => ({
  getPermissionsService: (sessionId: string) => mocks.getPermissionsService(sessionId),
  PERMISSIONS_READY_CHANNEL: "permissions:ready",
  PERMISSIONS_DECISION_CHANNEL: "permissions:decision",
}));

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
      ) => CompletionItem[] | null | Promise<CompletionItem[] | null>;
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
    hasUI: true,
    isProjectTrusted: () => overrides.trusted ?? true,
    modelRegistry: {
      find: () => undefined,
      getProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getSessionId: () => "s1",
      buildContextEntries: () => [],
      getBranch: () => [],
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
 * Construct the extension without firing session_start — the base for
 * lifecycle tests that assert on construction state or drive events by
 * hand. `setupExtension` (below) builds on this and fires session_start.
 *
 * @param service - The permissions service to install (the standard
 *   fakeService by default; `null` for the no-service state).
 * @param deps - Extra createAiGuardExtension deps (loadConfig, saveConfig).
 * @returns The mock pi, the stub pipeline's captured calls, and its
 *   createPipeline (for "not called" assertions).
 */
function installExtension(
  service: unknown = { registerAuthorizer: mocks.registerAuthorizer },
  deps: Record<string, unknown> = {},
) {
  const pi = makeMockPi();
  if (service !== null) mocks.getPermissionsService.mockReturnValue(service);
  const { createPipeline, calls } = makeStubPipeline();
  createAiGuardExtension(pi as any, { createPipeline, ...deps });
  return { pi, calls, createPipeline };
}

/**
 * Create the extension with a stub pipeline, fire session_start, and return
 * the mock pi + the captured pipeline deps — the shared setup for the
 * settings/persistence/tree follow-up describes.
 *
 * @param sessionCtxOverrides - Extra makeSessionCtx overrides (sessionManager fixtures, ui).
 * @returns The mock pi and the captured pipeline deps.
 */
function setupExtension(sessionCtxOverrides: Parameters<typeof makeSessionCtx>[0] = {}) {
  const { pi, calls } = installExtension();
  pi.fire("session_start", {}, makeSessionCtx(sessionCtxOverrides));
  return { pi, calls };
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
  mocks.getPermissionsService.mockReturnValue(undefined);
});

describe("createAiGuardExtension lifecycle", () => {
  it("registers authorizer when session_start fires and permissions service is available", () => {
    const { pi, createPipeline } = installExtension();

    // Before session_start: no registration
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();

    // session_start → register (the service is already available).
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("s1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(mocks.registerAuthorizer).toHaveBeenCalledWith("ai-guard", expect.any(Function));
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it("registers when permissions service becomes available after session_start", () => {
    // session_start fires before the permission service is published:
    // tryRegister finds no service and skips. permissions:ready then
    // fires and completes registration.
    const { pi, createPipeline } = installExtension(null);

    // No service yet → session_start does not register.
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();

    // Service published + permissions:ready → register.
    const fakeService = { registerAuthorizer: mocks.registerAuthorizer };
    mocks.getPermissionsService.mockReturnValue(fakeService);
    pi.fireEvent("permissions:ready");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("does not register when permissions service is unavailable", () => {
    const { pi, createPipeline } = installExtension(null);
    pi.fire("session_start", {}, makeSessionCtx());
    pi.fireEvent("permissions:ready");

    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();
    expect(createPipeline).not.toHaveBeenCalled();
  });

  it("a repeated session_start without shutdown re-points the live pipeline at the new session", async () => {
    // The observable M1 regression: pi re-dispatches session_start on
    // reload/fork without an intervening shutdown. The LIVE registration
    // must track the new session — the previous session's override is
    // reset, per-session breaker/cache are fresh (no leak), and runtime
    // writes after the re-dispatch land on the object the live pipeline
    // reads.
    const { pi, calls } = installExtension();

    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    const live = calls[0]!;

    // A session override reaches the pipeline's overrides object.
    await pi.commands.get("ai-guard")!.handler("mode lenient", makeUiCtx());
    expect(live.overrides.mode).toBe("lenient");

    // Re-dispatched session_start (no shutdown in between).
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.dispose).toHaveBeenCalledTimes(1); // stale registration disposed
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(2);
    // The overrides object keeps its identity (every pipeline generation's
    // captured reference stays valid) but was reset in place: the new
    // session starts from the config default.
    expect(calls[1]!.overrides).toBe(live.overrides);
    expect(live.overrides.mode).toBeUndefined();
    // Per-session state does not leak across sessions.
    expect(calls[1]!.circuitBreaker).not.toBe(live.circuitBreaker);
    expect(calls[1]!.verdictCache).not.toBe(live.verdictCache);

    // A runtime write after the re-dispatch reaches the live pipeline.
    await pi.commands.get("ai-guard")!.handler("mode strict", makeUiCtx());
    expect(calls[1]!.overrides.mode).toBe("strict");
  });

  it("permissions:ready after registration is a no-op (register once per session)", () => {
    const { pi, createPipeline } = installExtension();

    // session_start → register
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);

    // v27 re-emits ready (a latch at the node's first before_agent_start):
    // the link registers once per session — no dispose, no re-register.
    pi.fireEvent("permissions:ready");
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("preserves session state across permissions:ready (no re-registration)", () => {
    // The session object (config, circuitBreaker, verdictCache) is never
    // touched by permissions:ready — v27 ready only completes a missing
    // registration; it must not rebuild the session (loadConfig would run
    // again, resetting breaker counts and cache entries).
    let loadCalls = 0;
    const config = configSchema.parse({ provider: "test", model: "test" });
    const { pi } = installExtension(undefined, {
      loadConfig: () => {
        loadCalls++;
        return { config, issues: [] };
      },
    });

    pi.fire("session_start", {}, makeSessionCtx());
    expect(loadCalls).toBe(1);

    // ready is idempotent: registration count and loadConfig stay put.
    pi.fireEvent("permissions:ready");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(loadCalls).toBe(1); // session not rebuilt → breaker/cache preserved
  });

  it("permissions:ready is a no-op when not yet registered and no session", () => {
    const { pi, createPipeline } = installExtension();

    // permissions:ready before session_start → no session → no registration.
    pi.fireEvent("permissions:ready");
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it("session_shutdown disposes and resets all state", () => {
    const { pi, createPipeline } = installExtension();

    // session_start → register
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);

    // session_shutdown → dispose + reset + footer status cleared
    pi.fire("session_shutdown", {}, makeSessionCtx());
    expect(mocks.dispose).toHaveBeenCalledTimes(1);

    // After shutdown, a new session_start should register again
    mocks.registerAuthorizer.mockClear();
    mocks.dispose.mockClear();
    pi.fire("session_start", {}, makeSessionCtx());
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("session_shutdown does not throw when no registration was active", () => {
    const { pi, createPipeline } = installExtension(null);

    expect(() => pi.fire("session_shutdown", {}, makeSessionCtx())).not.toThrow();
  });

  it("subscribes to permissions:ready channel on construction", () => {
    const { pi, createPipeline } = installExtension(null);
    expect(pi.events.on).toHaveBeenCalledWith("permissions:ready", expect.any(Function));
  });

  it("subscribes to session_start and session_shutdown on construction", () => {
    const { pi, createPipeline } = installExtension(null);
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("hosts without a session id register once the ready payload carries one", () => {
    const { pi, createPipeline } = installExtension();

    // Host floor without getSessionId: the fallback self-read maps to null
    // → not registered yet.
    pi.fire("session_start", {}, makeSessionCtx({ sessionManager: { getSessionId: () => "" } }));
    expect(mocks.getPermissionsService).not.toHaveBeenCalled();
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();
    expect(createPipeline).not.toHaveBeenCalled();

    // The official source — the ready payload — carries the node's id →
    // adopt and register (the old seed-only code could never recover here).
    pi.fireEvent("permissions:ready", { sessionId: "s1", adjudicatesLocally: false });
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("s1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it("a throwing getSessionId is not fatal — the ready payload id still registers", () => {
    const { pi, createPipeline } = installExtension();

    expect(() =>
      pi.fire(
        "session_start",
        {},
        makeSessionCtx({
          sessionManager: {
            getSessionId: () => {
              throw new Error("no session id");
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(mocks.getPermissionsService).not.toHaveBeenCalled();
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();

    // The ready payload is unaffected by the throwing getter — adopt + register.
    pi.fireEvent("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
    expect(mocks.getPermissionsService).toHaveBeenCalledWith("s1");
    expect(mocks.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("config load failures are warned and block registration", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, createPipeline } = installExtension(undefined, {
      loadConfig: () => ({ config: undefined, issues: [{ path: "$", message: "bad config" }] }),
    });

    const ctx = makeSessionCtx();
    pi.fire("session_start", {}, ctx);

    // Config is undefined → authorizer not registered (no config = no
    // review), and the fail-safe start notifies at error grade: the
    // operator believes a reviewer stands in front of asks and none does.
    expect(mocks.registerAuthorizer).not.toHaveBeenCalled();
    expect(createPipeline).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bad config"));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("running in fail-safe mode with no auto-review"),
      "error",
    );

    warnSpy.mockRestore();
  });

  it("a repeated fail-safe session_start notifies again (each re-dispatch is a fresh absence)", () => {
    const { pi } = installExtension(undefined, {
      loadConfig: () => ({ config: undefined, issues: [] }),
    });

    // pi re-dispatches session_start on reload/fork without an
    // intervening shutdown — no latch: every re-dispatch genuinely
    // restarts an unreviewed session, so every one notifies.
    const first = makeSessionCtx();
    pi.fire("session_start", {}, first);
    const second = makeSessionCtx();
    pi.fire("session_start", {}, second);
    expect(first.ui.notify).toHaveBeenCalledTimes(1);
    expect(second.ui.notify).toHaveBeenCalledTimes(1);
    expect(second.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("running in fail-safe mode with no auto-review"),
      "error",
    );
  });

  it("passes cwd and trustedProject from session context to config loader", () => {
    const loadConfig = vi.fn<(env: ConfigEnv) => LoadConfigResult>(() => ({
      config: {
        provider: "test",
        model: "test",
        surfaces: ["bash"],
        transcript: { maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 },
        circuitBreaker: { consecutive: 3, total: 20, verdict: "deny" as const },
        cache: { maxEntries: 0 },
        timeoutMs: 10000,
        maxTokens: 4096,
        reasoning: "off" as const,
        instructions: null,
        mode: "default" as const,
        notifyLevel: "info" as const,
      },
      issues: [],
    }));

    const { pi } = installExtension(undefined, { loadConfig });

    pi.fire("session_start", {}, makeSessionCtx({ cwd: "/my-project", trusted: false }));

    expect(loadConfig).toHaveBeenCalledWith({ cwd: "/my-project", trustedProject: false });
  });

  it("handles registerAuthorizer throwing without crashing", () => {
    const throwingRegister = vi.fn<(name: string, authorize: unknown) => never>(() => {
      throw new Error("registration failed");
    });
    const { pi } = installExtension({ registerAuthorizer: throwingRegister });

    // session_start calls tryRegister which calls registerAuthorizer.
    // The throw must not propagate — it's caught and notified at error
    // grade: the guard is absent and the operator must see it.
    const ctx = makeSessionCtx();
    expect(() => pi.fire("session_start", {}, ctx)).not.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed to register the reviewer"),
      "error",
    );
  });

  it("warns on 'already registered' (stale registration survived disposal)", () => {
    // The exact message AuthorizerRegistry.register throws.
    const duplicateRegister = vi.fn<(name: string, authorize: unknown) => never>(() => {
      throw new Error("An authorizer is already registered for 'ai-guard'.");
    });
    const { pi } = installExtension({ registerAuthorizer: duplicateRegister });

    const ctx = makeSessionCtx();
    pi.fire("session_start", {}, ctx);

    // In v27 every node owns its service: a duplicate means a stale
    // registration survived disposal (/reload glitch) and still governs
    // asks — rare but never benign, error-grade through notify.
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("stale ai-guard registration survived disposal"),
      "error",
    );
  });

  it("does not downgrade a similar-but-different 'already registered' error", () => {
    // Different link name in the message — must NOT match the downgrade.
    const similarRegister = vi.fn<(name: string, authorize: unknown) => never>(() => {
      throw new Error("An authorizer is already registered for 'other-link'.");
    });
    const { pi } = installExtension({ registerAuthorizer: similarRegister });

    const ctx = makeSessionCtx();
    pi.fire("session_start", {}, ctx);

    // Different name → the generic registration-failure copy, not the
    // stale-registration one.
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed to register the reviewer"),
      "error",
    );
  });
});

describe("createAiGuardExtension — /ai-guard command + ctrl+alt+g shortcut", () => {
  it("registers the /ai-guard command and the ctrl+alt+g shortcut", () => {
    const { pi } = setupExtension();
    expect(pi.commands.has("ai-guard")).toBe(true);
    expect(pi.shortcuts.has("ctrl+alt+g")).toBe(true);
  });

  it("/ai-guard mode <value> mutates the live pipeline's session overrides", async () => {
    const { pi, calls } = setupExtension();
    const deps = calls[0]!;
    expect(deps.overrides.mode).toBeUndefined();

    const ctx = makeUiCtx();
    await pi.commands.get("ai-guard")!.handler("mode lenient", ctx);

    // The pipeline closed over this exact object at registration — the
    // override takes effect without re-registering the authorizer.
    expect(deps.overrides.mode).toBe("lenient");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "lenient (session)");
  });
});

describe("createAiGuardExtension — mode session persistence", () => {
  it("session_start restores the override from the leaf entry and shows the footer status", () => {
    const setStatus = vi.fn<() => void>();
    const { calls } = setupExtension({
      sessionManager: { getBranch: () => [settingEntry("strict")] },
      ui: { setStatus },
    });
    // The restored override is live in the deps the pipeline closed over.
    expect(calls[0]!.overrides.mode).toBe("strict");
    expect(setStatus).toHaveBeenCalledWith("ai-guard", "strict (session)");
  });

  it("session_start clears the footer for the default mode (no baseline noise)", () => {
    const setStatus = vi.fn<() => void>();
    setupExtension({ ui: { setStatus } });
    expect(setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("session_shutdown clears the footer status", () => {
    const setStatus = vi.fn<() => void>();
    const { pi } = installExtension();

    pi.fire("session_start", {}, makeSessionCtx({ ui: { setStatus } }));
    expect(setStatus).toHaveBeenCalledWith("ai-guard", undefined);

    pi.fire("session_shutdown", {}, makeSessionCtx({ ui: { setStatus } }));
    expect(setStatus).toHaveBeenLastCalledWith("ai-guard", undefined);
  });
});

describe("createAiGuardExtension — official-pattern follow-ups", () => {
  it("session_tree re-derives the override from the new active branch", () => {
    const setStatus = vi.fn<() => void>();
    const { pi, calls } = setupExtension({
      sessionManager: { getBranch: () => [settingEntry("lenient")] },
      ui: { setStatus },
    });
    expect(calls[0]!.overrides.mode).toBe("lenient");

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
    const { pi, calls } = setupExtension();
    expect(calls[0]!.overrides.mode).toBeUndefined();

    pi.fire(
      "session_tree",
      {},
      makeSessionCtx({
        sessionManager: { getBranch: () => [settingEntry("strict")] },
      }),
    );

    expect(calls[0]!.overrides.mode).toBe("strict");
  });
});

describe("createAiGuardExtension — save-config actions", () => {
  it("save-config global snapshots the effective config through the wired save function", async () => {
    const saveConfig = vi.fn<
      (
        target: ConfigLayerTarget,
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >((target) => ({ path: `/agent/config-${target}.json`, created: false, changed: true }));
    const config = configSchema.parse({ provider: "test", model: "test" });
    const { pi } = installExtension(undefined, {
      loadConfig: () => ({ config, issues: [] }),
      saveConfig,
    });

    const sessionCtx = makeSessionCtx();
    pi.fire("session_start", {}, sessionCtx);
    const ctx = makeUiCtx();
    await pi.commands.get("ai-guard")!.handler("save-config global", ctx);

    // The effective mode: after restore (a no-op here) no dead override
    // key exists, so the config's own mode flows into the snapshot.
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0]![0]).toBe("global");
    expect(saveConfig.mock.calls[0]![1].mode).toBe("default");
    // Saving is a config-layer write; no session override is added.
    expect(pi.appendEntry).not.toHaveBeenCalled();
    // Command feedback rides the session notify seam — the session ctx's
    // notify carries it (prefix applied there), never the command ctx's
    // ui, and no footer sync happens for a config-layer save.
    expect(sessionCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("[ai-guard] saved to global config"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("production wiring: an untrusted session's save-config project is refused by the real persist", async () => {
    const config = configSchema.parse({ provider: "test", model: "test" });
    // No saveConfig injected: the production persistConfigLayer runs.
    const { pi } = installExtension(undefined, {
      loadConfig: () => ({ config, issues: [] }),
    });

    // Point the session cwd at a throwaway tmp dir: the guard must refuse
    // BEFORE any filesystem work, and even if that ordering ever weakens,
    // the write lands here (and gets removed) — never the real
    // ~/.pi/agent dir.
    const tmpCwd = mkdtempSync(join(tmpdir(), "ai-guard-untrusted-"));
    try {
      const sessionCtx = makeSessionCtx({ trusted: false, cwd: tmpCwd });
      pi.fire("session_start", {}, sessionCtx);
      const ctx = makeUiCtx();
      await pi.commands.get("ai-guard")!.handler("save-config project", ctx);

      expect(sessionCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("[ai-guard] could not save to project config"),
        "error",
      );
      // Positive proof the guard never touched disk: the project dir must
      // not exist even transiently.
      expect(existsSync(join(tmpCwd, ".pi"))).toBe(false);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
