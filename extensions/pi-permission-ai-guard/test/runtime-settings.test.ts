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
import type { SessionOverrides } from "#src/session-state.ts";

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
  const settings: RuntimeSettings = new RuntimeSettingsClass(
    {
      session: {
        session: { config: configSchema.parse({ provider: "test", model: "test" }) },
        overrides,
      },
      appendEntry,
      saveConfig:
        saveConfig ??
        ((target) => ({ path: `/config-${target}.json`, created: false, changed: true })),
    },
    SPECS,
  );
  return { settings, overrides, appendEntry };
}

describe("RuntimeSettings — command", () => {
  it("the direct form applies a value: override + persist + notify + footer", async () => {
    const { settings, overrides, appendEntry } = makeSettings();
    const ctx = makeUiCtx();
    await settings.command.handler("mode advisory", ctx);

    expect(overrides.mode).toBe("advisory");
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { mode: "advisory" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] mode = advisory (session override)",
      "info",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "advisory (session)");
  });

  it("reset clears the override, persists null, and shows the config default", async () => {
    const { settings, overrides, appendEntry } = makeSettings({ mode: "strict" });
    const ctx = makeUiCtx();
    await settings.command.handler("mode reset", ctx);

    expect(overrides.mode).toBeUndefined();
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { mode: null });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] mode = default (config default)",
      "info",
    );
    // Default is the shipped baseline — the line clears instead of showing it.
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", undefined);
  });

  it("unknown setting or invalid value notifies an error and changes nothing", async () => {
    const { settings, overrides, appendEntry } = makeSettings();
    const ctx = makeUiCtx();
    await settings.command.handler("mode yolo", ctx);
    await settings.command.handler("surfaces bash", ctx);

    expect(overrides.mode).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      '[ai-guard] invalid value "yolo" for mode — valid values are strict|default|advisory|lenient|permissive|reset',
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      '[ai-guard] unknown setting "surfaces" (mode)',
      "error",
    );
  });

  it("without an active session warns instead of crashing", async () => {
    const overrides: SessionOverrides = {};
    const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
    const settings = new RuntimeSettingsClass(
      {
        session: { session: undefined, overrides },
        appendEntry,
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    const ctx = makeUiCtx();
    await settings.command.handler("mode advisory", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] no active session (config not loaded)",
      "warning",
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
      "ai-guard settings — pick a setting to adjust, or save the current config",
      ["mode — default (config)", "save global config", "save project config"],
    );
    expect(overrides.mode).toBe("strict");
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
    const { settings, overrides } = makeSettings();
    const noUi = makeUiCtx();
    noUi.hasUI = false;

    await settings.command.handler("mode", noUi);
    expect(noUi.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] settings menu needs an interactive UI — use /ai-guard <setting> <value>",
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
    const settings = new RuntimeSettingsClass(
      {
        session: { session: undefined, overrides },
        appendEntry: () => {},
        saveConfig: () => ({ path: "/config.json", created: false, changed: true }),
      },
      SPECS,
    );
    const ctx = makeUiCtx();
    expect(() => settings.shortcut.handler(ctx)).not.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] no active session (config not loaded)",
      "warning",
    );
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
        session: { session: undefined, overrides },
        appendEntry: () => {},
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
    const { settings } = makeSettings({ mode: "advisory" }, saveConfig);
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    // The snapshot merges the session override over the loaded config —
    // every field flows, so future command-configured settings ride along.
    expect(saveConfig).toHaveBeenCalledTimes(1);
    const [target, config] = saveConfig.mock.calls[0]!;
    expect(target).toBe("global");
    expect(config.mode).toBe("advisory"); // override won over the snapshot
    expect(config.provider).toBe("test"); // other fields intact
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] saved to global config (cfg-global.json) — new sessions start from it; higher layers still shadow it; this session keeps its overrides",
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
    const { settings } = makeSettings({}, () => ({
      path: "/cfg.json",
      created: false,
      changed: false,
      error: "not valid JSONC",
    }));
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] could not save to global config — not valid JSONC",
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
    const { settings } = makeSettings({}, () => ({
      path: "/cfg.json",
      created: false,
      changed: false,
    }));
    const ctx = makeUiCtx();

    await settings.command.handler("save-to-global-config", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] global config already matches — nothing written",
      "info",
    );
  });
});

describe("RuntimeSettings — picker stays plain for the highlighted value", () => {
  it("applies a plain permissive pick and notifies at warning level, undecorated", async () => {
    const { settings, overrides } = makeSettings();
    const ctx = makeUiCtx("permissive — only clear high-danger requests are blocked");
    await settings.command.handler("mode", ctx);
    expect(overrides.mode).toBe("permissive");
    // The command surface is plain text — the warning-red emphasis is
    // footer-only. The severity bump stays.
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[ai-guard] mode = permissive (session override)",
      "warning",
    );
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
