/**
 * RuntimeSettings direct tests: the /ai-guard command dispatch, picker
 * flows, completion, the cycle shortcut, footer projection, persistence,
 * and restore — through the module's own interface, with a plain session
 * surface (SessionLifecycle satisfies it structurally in production).
 */

import { describe, expect, it, vi } from "vitest";

import { MODE_VALUES, type AiGuardConfig, configSchema } from "#src/config-schema.ts";
import { MODE_BLURBS } from "#src/mode-table.ts";
import {
  type EnumSettingSpec,
  type RuntimeSettings,
  RuntimeSettings as RuntimeSettingsClass,
} from "#src/runtime-settings.ts";
import { CircuitBreaker, type SessionOverrides } from "#src/session-state.ts";

const SPECS: readonly EnumSettingSpec[] = [
  {
    name: "mode",
    values: [...MODE_VALUES],
    description: "what happens to the reviewer's denials and uncertainty",
    hiddenValue: "default",
    cycleValues: ["default", "advisory", "lenient"],
    highlightValue: "permissive",
    optionDetails: MODE_BLURBS,
  },
];

/**
 * A command/shortcut UI context mock with spies.
 *
 * @param selectResult - What ui.select resolves with (undefined = cancel).
 * @returns The mock ctx.
 */
function makeUiCtx(selectResult?: string) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn<(message: string, type?: "info" | "warning" | "error") => void>(),
      setStatus: vi.fn<(key: string, text: string | undefined) => void>(),
      select: vi.fn<() => Promise<string | undefined>>(async () => selectResult),
    },
  };
}

/**
 * Build settings over a plain surface with the config default.
 *
 * @param overridesInit - Initial overrides (mutated by the settings).
 * @param saveConfig - Optional config-layer save stub (default: a path
 *   echo reporting a change).
 * @returns The settings, the overrides object, and the append spy.
 */
function makeSettings(
  overridesInit: SessionOverrides = {},
  saveConfig?: (
    target: "global" | "project",
    config: AiGuardConfig,
  ) => {
    path: string;
    created: boolean;
    changed: boolean;
    error?: string;
  },
) {
  const overrides: SessionOverrides = { ...overridesInit };
  const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
  const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
  const settings: RuntimeSettings = new RuntimeSettingsClass(
    {
      session: {
        session: { config: configSchema.parse({ provider: "test", model: "test" }) },
        overrides,
        circuitBreaker: new CircuitBreaker(),
      },
      appendEntry,
      notify,
      saveConfig:
        saveConfig ??
        ((target) => ({ path: `/config-${target}.json`, created: false, changed: true })),
    },
    SPECS,
  );
  return { settings, overrides, appendEntry, notify };
}

describe("RuntimeSettings — command", () => {
  it("the direct form applies a value: override + persist + notify + footer", async () => {
    const { settings, overrides, appendEntry, notify } = makeSettings();
    const ctx = makeUiCtx();
    await settings.command.handler("mode advisory", ctx);

    expect(overrides.mode).toBe("advisory");
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { mode: "advisory" });
    expect(notify).toHaveBeenCalledWith("mode = advisory (session override)", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "advisory (session)");
  });

  it("reset clears the override, persists null, and shows the config default", async () => {
    const { settings, overrides, appendEntry, notify } = makeSettings({ mode: "strict" });
    const ctx = makeUiCtx();
    await settings.command.handler("mode reset", ctx);

    expect(overrides.mode).toBeUndefined();
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { mode: null });
    expect(notify).toHaveBeenCalledWith("mode = default (config default)", "info");
    // Default is the shipped baseline — the line clears instead of showing it.
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("unknown setting or invalid value notifies an error and changes nothing", async () => {
    const { settings, overrides, appendEntry, notify } = makeSettings();
    const ctx = makeUiCtx();
    await settings.command.handler("mode yolo", ctx);
    await settings.command.handler("surfaces bash", ctx);

    expect(overrides.mode).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'invalid value "yolo" for mode — valid values are strict|default|advisory|lenient|permissive|reset',
      "error",
    );
    expect(notify).toHaveBeenCalledWith('unknown setting "surfaces" (mode)', "error");
  });

  it("without an active session warns instead of crashing", async () => {
    const overrides: SessionOverrides = {};
    const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: { session: undefined, overrides, circuitBreaker: new CircuitBreaker() },
        appendEntry,
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    const ctx = makeUiCtx();
    await settings.command.handler("mode advisory", ctx);
    expect(notify).toHaveBeenCalledWith("no active session (config not loaded)", "warning");
  });

  it("breaker reset clears both tiers and names what it does not touch", async () => {
    const breaker = new CircuitBreaker();
    const overrides: SessionOverrides = {};
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: {
          session: { config: configSchema.parse({ provider: "test", model: "test" }) },
          overrides,
          circuitBreaker: breaker,
        },
        appendEntry,
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    // A consecutive-tier trip (3 denies against consecutive:3/total:20) —
    // the copy names the softer tier.
    for (let i = 0; i < 3; i++) breaker.recordVerdict("deny");
    await settings.command.handler("breaker reset", makeUiCtx());
    expect(breaker.isTripped({ consecutive: 3, total: 20, verdict: "deny" })).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared (was tripped) — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
    // A pure counter reset: nothing persisted, no override touched.
    expect(appendEntry).not.toHaveBeenCalled();
    expect(overrides.mode).toBeUndefined();
  });

  it("breaker reset names the total tier when that is what was tripped", async () => {
    const breaker = new CircuitBreaker();
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    // A total-tier trip — the accident scenario this copy was written
    // for. The session's own breaker config sets total: 3 so three denies
    // reach the hard tier (not just the consecutive one).
    for (let i = 0; i < 3; i++) breaker.recordVerdict("deny");
    const settings = new RuntimeSettingsClass(
      {
        session: {
          session: {
            config: configSchema.parse({
              provider: "test",
              model: "test",
              circuitBreaker: { consecutive: 3, total: 3, verdict: "deny" },
            }),
          },
          overrides: {},
          circuitBreaker: breaker,
        },
        appendEntry: () => {},
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    expect(breaker.trippedTier({ consecutive: 3, total: 3, verdict: "deny" })).toBe("total");
    await settings.command.handler("breaker reset", makeUiCtx());
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared (was total-tier tripped) — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
  });

  it("breaker reset on an un-tripped breaker still answers cleanly", async () => {
    const breaker = new CircuitBreaker();
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: {
          session: { config: configSchema.parse({ provider: "test", model: "test" }) },
          overrides: {},
          circuitBreaker: breaker,
        },
        appendEntry: () => {},
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    await settings.command.handler("breaker reset", makeUiCtx());
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
  });

  it("the settings menu dispatches the breaker-reset entry", async () => {
    const breaker = new CircuitBreaker();
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: {
          session: { config: configSchema.parse({ provider: "test", model: "test" }) },
          overrides: {},
          circuitBreaker: breaker,
        },
        appendEntry: () => {},
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    for (let i = 0; i < 3; i++) breaker.recordVerdict("deny");
    const ctx = makeUiCtx("reset circuit breaker");
    await settings.command.handler("", ctx);
    expect(breaker.isTripped({ consecutive: 3, total: 20, verdict: "deny" })).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared (was tripped) — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
  });

  it("the settings menu and value picker apply the picked value", async () => {
    const { settings, overrides } = makeSettings();
    // Menu picks the (only) setting's label, then the value picker picks auto.
    const ctx = makeUiCtx();
    ctx.ui.select
      .mockResolvedValueOnce("mode — default (config)")
      .mockResolvedValueOnce("strict — the reviewer's allow is the only pass");
    await settings.command.handler("", ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith(
      "ai-guard settings — pick a setting to adjust, save the current config, or reset the breaker",
      [
        "mode — default (config)",
        "save global config",
        "save project config",
        "reset circuit breaker",
      ],
    );
    expect(overrides.mode).toBe("strict");
  });

  it("a second spec rides the same machinery (menu rows, direct form, footer)", async () => {
    // The generic spec machinery's first real multi-spec consumer —
    // nothing may assume a single setting.
    const overrides: SessionOverrides = {};
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: {
          session: { config: configSchema.parse({ provider: "test", model: "test" }) },
          overrides,
          circuitBreaker: new CircuitBreaker(),
        },
        appendEntry,
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      [
        ...SPECS,
        {
          name: "notifyLevel",
          values: ["info", "warning", "error", "off"],
          description: "the minimum ambient notify level",
          hiddenValue: "info",
        },
      ],
    );
    const ctx = makeUiCtx();
    ctx.ui.select.mockResolvedValueOnce("notifyLevel — info (config)").mockResolvedValueOnce("off");
    await settings.command.handler("", ctx);

    // Menu rows list BOTH settings (plus the save verbs); picking the
    // second spec and a value applies it like any other.
    expect(ctx.ui.select).toHaveBeenCalledWith(
      "ai-guard settings — pick a setting to adjust, save the current config, or reset the breaker",
      [
        "mode — default (config)",
        "notifyLevel — info (config)",
        "save global config",
        "save project config",
        "reset circuit breaker",
      ],
    );
    expect(overrides.notifyLevel).toBe("off");
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { notifyLevel: "off" });
    expect(notify).toHaveBeenCalledWith("notifyLevel = off (session override)", "info");
    // Footer fragments join per spec: only the deviation renders.
    settings.syncFooter(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "off (session)");
  });

  it("cancelling the picker changes nothing", async () => {
    const { settings, overrides, appendEntry } = makeSettings();
    const ctx = makeUiCtx(undefined);
    await settings.command.handler("mode", ctx);
    await settings.command.handler("", ctx);

    expect(overrides.mode).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("the picker paths require a dialog-capable UI; the direct form does not", async () => {
    const { settings, overrides, notify } = makeSettings();
    const noUi = makeUiCtx();
    noUi.hasUI = false;

    await settings.command.handler("mode", noUi);
    expect(notify).toHaveBeenCalledWith(
      "settings menu needs an interactive UI — use /ai-guard <setting> <value>",
      "error",
    );
    expect(overrides.mode).toBeUndefined();

    await settings.command.handler("mode advisory", noUi);
    expect(overrides.mode).toBe("advisory");
  });
});

describe("RuntimeSettings — completions", () => {
  it("completes setting names first, then the setting's values", () => {
    const { settings } = makeSettings();
    const completions = settings.command.getArgumentCompletions;
    expect(completions("mo")).toEqual([
      { value: "mode", label: "mode — what happens to the reviewer's denials and uncertainty" },
    ]);
    expect(completions("mode ")).toEqual([
      { value: "strict", label: "strict" },
      { value: "default", label: "default" },
      { value: "advisory", label: "advisory" },
      { value: "lenient", label: "lenient" },
      { value: "permissive", label: "permissive" },
      { value: "reset", label: "reset" },
    ]);
    // Save verbs complete at the TOP level, not inside a setting.
    expect(completions("save")).toEqual([
      { value: "save-to-global-config", label: "save global config" },
      { value: "save-to-project-config", label: "save project config" },
    ]);
    expect(completions("mode de")).toEqual([{ value: "default", label: "default" }]);
    expect(completions("mode nope")).toBeNull();
    expect(completions("nope")).toBeNull();
    expect(completions("nope ")).toBeNull();
  });

  it("completes the breaker reset action alongside the verbs", () => {
    const { settings } = makeSettings();
    const completions = settings.command.getArgumentCompletions;
    expect(completions("bre")).toEqual([
      { value: "breaker", label: "breaker — reset the circuit breaker" },
    ]);
    expect(completions("breaker ")).toEqual([{ value: "reset", label: "reset" }]);
    expect(completions("breaker re")).toEqual([{ value: "reset", label: "reset" }]);
    expect(completions("breaker nope")).toBeNull();
  });
});

describe("RuntimeSettings — shortcut", () => {
  it("cycles the session mode and wraps back to default", () => {
    const { settings, overrides } = makeSettings();
    const ctx = makeUiCtx();

    // The cycle visits only the casual subset (default → advisory →
    // lenient), one press loosens one notch, and the wrap returns to
    // default — the extremes stay reachable via the command only.
    settings.shortcut.handler(ctx);
    expect(overrides.mode).toBe("advisory");
    settings.shortcut.handler(ctx);
    expect(overrides.mode).toBe("lenient");
    settings.shortcut.handler(ctx);
    expect(overrides.mode).toBe("default");
  });

  it("cycles from an override, one notch looser", () => {
    const { settings, overrides } = makeSettings({ mode: "advisory" });
    settings.shortcut.handler(makeUiCtx());
    expect(overrides.mode).toBe("lenient");
  });

  it("a value outside the cycle subset anchors to the subset start", () => {
    const { settings, overrides } = makeSettings({ mode: "strict" });
    settings.shortcut.handler(makeUiCtx());
    expect(overrides.mode).toBe("default");
    const { settings: s2, overrides: o2 } = makeSettings({ mode: "permissive" });
    s2.shortcut.handler(makeUiCtx());
    expect(o2.mode).toBe("default");
  });

  it("without an active session warns instead of crashing", () => {
    const overrides: SessionOverrides = {};
    const notify = vi.fn<(message: string, level?: "info" | "warning" | "error") => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: { session: undefined, overrides, circuitBreaker: new CircuitBreaker() },
        appendEntry: () => {},
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    const ctx = makeUiCtx();
    expect(() => settings.shortcut.handler(ctx)).not.toThrow();
    expect(notify).toHaveBeenCalledWith("no active session (config not loaded)", "warning");
  });
});

describe("RuntimeSettings — restore + footer", () => {
  it("restore applies the persisted override through the stable overrides object", () => {
    const { settings, overrides } = makeSettings();
    settings.restore({
      getBranch: () =>
        [{ type: "custom", customType: "ai-guard-setting", data: { mode: "strict" } }] as never[],
    });
    expect(overrides.mode).toBe("strict");
  });

  it("restore with no entries clears any stale override", () => {
    const { settings, overrides } = makeSettings({ mode: "advisory" });
    settings.restore({ getBranch: () => [] });
    expect(overrides.mode).toBeUndefined();
  });

  it("syncFooter shows the effective value with the (session) marker while overridden", () => {
    const { settings } = makeSettings({ mode: "strict" });
    const ctx = makeUiCtx();
    settings.syncFooter(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "strict (session)");
  });

  it("syncFooter renders the highlighted value in warning red", () => {
    const { settings } = makeSettings({ mode: "permissive" });
    const ctx = makeUiCtx();
    settings.syncFooter(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "ai-guard",
      "\x1b[1;31mpermissive (session)\x1b[0m",
    );
  });

  it("syncFooter hides the default mode — the line clears instead of showing the baseline", () => {
    const { settings } = makeSettings();
    const ctx = makeUiCtx();
    settings.syncFooter(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("syncFooter hides a session override back to default too", () => {
    const { settings } = makeSettings({ mode: "default" });
    const ctx = makeUiCtx();
    settings.syncFooter(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("syncFooter without an active session sets nothing", () => {
    const overrides: SessionOverrides = {};
    const settings = new RuntimeSettingsClass(
      {
        session: { session: undefined, overrides, circuitBreaker: new CircuitBreaker() },
        appendEntry: () => {},
        notify: () => {},
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    const ctx = makeUiCtx();
    settings.syncFooter(ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("clearFooter clears the line", () => {
    const { settings } = makeSettings();
    const ctx = makeUiCtx();
    settings.clearFooter(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });
});

describe("RuntimeSettings — save to config layer actions", () => {
  it("save-to-global snapshots the full effective config (overrides merged)", async () => {
    const saveConfig = vi.fn<
      (
        target: "global" | "project",
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >((target) => ({ path: `/cfg-${target}.json`, created: false, changed: true }));
    const { settings, notify } = makeSettings({ mode: "advisory" }, saveConfig);
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    // The snapshot merges the session override over the loaded config —
    // every field flows, so future command-configured settings ride along.
    expect(saveConfig).toHaveBeenCalledTimes(1);
    const [target, config] = saveConfig.mock.calls[0]!;
    expect(target).toBe("global");
    expect(config.mode).toBe("advisory"); // override won over the snapshot
    expect(config.provider).toBe("test"); // other fields intact
    expect(notify).toHaveBeenCalledWith(
      "saved to global config (cfg-global.json) — new sessions start from it; this session keeps current overrides",
      "info",
    );
  });

  it("save-to-project passes the project target through", async () => {
    const saveConfig = vi.fn<
      (
        target: "global" | "project",
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >((target) => ({ path: `/cfg-${target}.json`, created: false, changed: true }));
    const { settings } = makeSettings({}, saveConfig);
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-project-config", ctx);

    expect(saveConfig.mock.calls[0]![0]).toBe("project");
  });

  it("notifies a refusal and changes nothing when the save errors", async () => {
    const { settings, notify } = makeSettings({}, () => ({
      path: "/cfg.json",
      created: false,
      changed: false,
      error: "not valid JSONC",
    }));
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    expect(notify).toHaveBeenCalledWith(
      "could not save to global config — not valid JSONC",
      "error",
    );
  });

  it("a no-override session saves the config's own value — no dead key shadows", async () => {
    const saveConfig = vi.fn<
      (
        target: "global" | "project",
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >(() => ({ path: "/cfg.json", created: false, changed: true }));
    const { settings, overrides } = makeSettings({}, saveConfig);
    settings.restore({ getBranch: () => [] });
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    expect(saveConfig.mock.calls[0]![1].mode).toBe("default");
    expect("mode" in overrides).toBe(false); // restore-noop left no dead key
  });

  it("save after an override reset carries the config value — the undefined-shadow is gone", async () => {
    const saveConfig = vi.fn<
      (
        target: "global" | "project",
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >(() => ({ path: "/cfg.json", created: false, changed: true }));
    const { settings, overrides } = makeSettings({ mode: "advisory" }, saveConfig);
    const ctx = makeUiCtx();

    await settings.command.handler("mode reset", ctx); // deletes the override
    await settings.command.handler("save-to-global-config", ctx);

    expect(saveConfig.mock.calls[0]![1].mode).toBe("default");
    expect("mode" in overrides).toBe(false);
  });

  it("reset deletes the override key outright (present ⇒ defined invariant)", () => {
    const { settings, overrides } = makeSettings({ mode: "advisory" });
    const ctx = makeUiCtx();
    void settings.command.handler("mode reset", ctx);
    expect("mode" in overrides).toBe(false);
    expect(overrides.mode).toBeUndefined();
  });

  it("the direct save form needs no picker UI — hasUI=false still saves", async () => {
    const saveConfig = vi.fn<
      (
        target: "global" | "project",
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >(() => ({ path: "/cfg.json", created: false, changed: true }));
    const { settings } = makeSettings({}, saveConfig);
    const noUi = makeUiCtx();
    noUi.hasUI = false;

    await settings.command.handler("save-to-global-config", noUi);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0]![0]).toBe("global");
  });

  it("the root menu applies a picked save action directly", async () => {
    const saveConfig = vi.fn<
      (
        target: "global" | "project",
        config: AiGuardConfig,
      ) => {
        path: string;
        created: boolean;
        changed: boolean;
      }
    >(() => ({ path: "/cfg.json", created: false, changed: true }));
    const { settings } = makeSettings({}, saveConfig);
    const ctx = makeUiCtx();
    ctx.ui.select.mockResolvedValueOnce("save project config");
    await settings.command.handler("", ctx);

    expect(saveConfig.mock.calls[0]![0]).toBe("project");
  });

  it("reports when the layer already matches (nothing written)", async () => {
    const { settings, notify } = makeSettings({}, () => ({
      path: "/cfg.json",
      created: false,
      changed: false,
    }));
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    expect(notify).toHaveBeenCalledWith("global config already matches — nothing written", "info");
  });
});

describe("RuntimeSettings — picker stays plain for the highlighted value", () => {
  it("applies a plain permissive pick and notifies at warning level, undecorated", async () => {
    const { settings, overrides, notify } = makeSettings();
    const ctx = makeUiCtx("permissive — only clear high-danger requests are blocked");
    await settings.command.handler("mode", ctx);
    expect(overrides.mode).toBe("permissive");
    // The command surface is plain text — the warning-red emphasis is
    // footer-only. The severity bump stays.
    expect(notify).toHaveBeenCalledWith("mode = permissive (session override)", "warning");
  });
});

describe("RuntimeSettings — settings-menu labels stay plain", () => {
  it("renders the mode label undecorated and resolves a plain pick", async () => {
    const { settings, overrides } = makeSettings({ mode: "permissive" });
    const menuOptions: string[][] = [];
    let calls = 0;
    const select = vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(
      async (title, options) => {
        if (calls++ === 0) {
          menuOptions.push(options);
          return "mode — permissive (session)";
        }
        return "permissive";
      },
    );
    const ctx = {
      hasUI: true,
      ui: { notify: vi.fn<() => void>(), setStatus: vi.fn<() => void>(), select },
    } as never;
    await settings.command.handler("", ctx);
    expect(overrides.mode).toBe("permissive");
    // The menu label is plain — the warning-red emphasis is footer-only.
    expect(menuOptions[0]![0]).toBe("mode — permissive (session)");
  });
});
