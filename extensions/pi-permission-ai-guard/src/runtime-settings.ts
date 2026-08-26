/**
 * The runtime settings surface: everything a session-scoped setting needs
 * around its value — the /ai-guard command (menu, dispatch, completion),
 * the ctrl+alt+g cycle shortcut, footer projection, session-file
 * persistence, and restore from the active branch.
 *
 * The interface is deliberately registration-shaped: the extension wires
 * `command` / `shortcut` into pi.registerCommand / registerShortcut and
 * calls `restore` / `syncFooter` / `clearFooter` from its session event
 * handlers. Everything else — picker flows, validation, notify + footer
 * UX, the persistence format — is implementation.
 *
 * Settings are enum-valued overrides over their same-named config field,
 * described declaratively by {@link EnumSettingSpec}: a setting named N
 * reads/writes `overrides.N`, falls back to `config.N`, persists under
 * key N, and offers `N <value>` + `N reset` on the command. Adding the
 * next setting is one spec entry here plus its schema/loader/docs — the
 * whole UX materializes from the spec.
 */

import type {
  ExtensionShortcut,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import type { ConfigLayerTarget, SaveConfigFn } from "./config-loader.ts";
import type { AiGuardConfig } from "./config-schema.ts";
import { NOTIFY_PREFIX } from "./logger.ts";
import {
  type SessionBranchReader,
  persistSetting,
  restoreSetting,
} from "./session-settings-store.ts";
import { effectiveConfig, type SessionOverrides } from "./session-state.ts";

/**
 * An enum-valued session setting overriding its same-named config field.
 * `name` must be a key of BOTH `SessionOverrides` and `AiGuardConfig`
 * (compile-checked) so the spec's reads and writes are real fields.
 */
export interface EnumSettingSpec {
  /** Setting name — command argument, persistence key, overrides key, config key. */
  readonly name: keyof SessionOverrides & keyof AiGuardConfig;
  /** Valid values, in shortcut-cycle order. */
  readonly values: readonly string[];
  /**
   * One-line what-this-changes description, shown in completion labels
   * (e.g. `mode — what happens to model denials`).
   */
  readonly description?: string;
  /**
   * A value not worth a footer line — the shipped baseline (e.g. "default").
   * When the effective value equals it, no fragment renders; an all-hidden
   * result clears the status line.
   */
  readonly hiddenValue?: string;
}

/**
 * The UI-context subset the settings surface uses — derived from the host's
 * contexts so the method signatures can't drift. Structurally satisfied by
 * the real `ExtensionContext` / `ExtensionCommandContext` the host passes
 * (both carry a full `ui: ExtensionUIContext` and the `hasUI` flag); the
 * narrow shape keeps test fixtures light.
 */
export interface AiGuardUiContext {
  /** Picker / notify / footer-status surface. */
  ui: Pick<ExtensionUIContext, "select" | "notify" | "setStatus">;
  /** Whether dialog-capable UI is available (TUI/RPC) — gates the picker paths. */
  hasUI: boolean;
}

/**
 * The /ai-guard command registration object — derived from pi's
 * `RegisteredCommand` (registerCommand's options shape). Only the handler's
 * ctx is narrowed to the consumed {@link AiGuardUiContext} subset.
 */
export type AiGuardCommand = Omit<RegisteredCommand, "name" | "sourceInfo" | "handler"> & {
  handler: (args: string, ctx: AiGuardUiContext) => Promise<void>;
  /** Required here: the command always registers completion support. */
  getArgumentCompletions: NonNullable<RegisteredCommand["getArgumentCompletions"]>;
};

/**
 * The ctrl+alt+g shortcut registration object — derived from pi's
 * `ExtensionShortcut` (registerShortcut's options shape), handler ctx
 * narrowed to the consumed subset like the command's.
 */
export type AiGuardShortcut = Omit<ExtensionShortcut, "shortcut" | "extensionPath" | "handler"> & {
  handler: (ctx: AiGuardUiContext) => void;
};

/** The settings' view of session state — {@link SessionLifecycle} satisfies this structurally. */
export interface SettingsSessionSurface {
  /** The live session's config, or undefined when no session is active. */
  readonly session: { readonly config: AiGuardConfig | undefined } | undefined;
  /** The stable overrides object (single write path, stable identity). */
  readonly overrides: SessionOverrides;
}

/** Injectable collaborators the settings surface persists through. */
export interface RuntimeSettingsDeps {
  /** Session-state view: effective values come from overrides-then-config. */
  session: SettingsSessionSurface;
  /** Session-file append (persistence of setting changes). */
  appendEntry: (customType: string, data?: unknown) => void;
  /**
   * Persists the current effective config snapshot into a config layer
   * (the "save to global/project config" actions). In production this
   * targets the global or project config file; tests inject a stub.
   */
  saveConfig: SaveConfigFn;
}

/**
 * One option in a setting's picker and completion surface: an enum value,
 * or the reset action. The union keeps the reset ACTION out of the value
 * channel — a spec whose values someday include a literal "reset" stays
 * unambiguous.
 */
type SettingOption = {
  readonly text: string;
  readonly kind: "value" | "reset";
};

/** Footer status key the settings line lives under. */
const FOOTER_KEY = "ai-guard";

/**
 * The save verbs, reserved at the command's top level: a setting spec must
 * never take one of these names (they'd shadow the action).
 */
const SAVE_VERBS = [
  { text: "save-to-global-config", target: "global" as const },
  { text: "save-to-project-config", target: "project" as const },
];

/**
 * Owns the runtime settings surface for the given specs.
 *
 * Generic accesses (`overrides[name]`, `config[name]`) carry the spec
 * invariant: the field exists on both types and holds strings (or
 * optional strings) — guaranteed by the `keyof` intersection on
 * {@link EnumSettingSpec.name} plus each spec's `values`.
 */
export class RuntimeSettings {
  readonly #deps: RuntimeSettingsDeps;
  readonly #specs: readonly EnumSettingSpec[];

  /**
   * @param deps - Session surface + session-file append.
   * @param specs - The settings this extension exposes.
   */
  constructor(deps: RuntimeSettingsDeps, specs: readonly EnumSettingSpec[]) {
    this.#deps = deps;
    this.#specs = specs;
  }

  /** The /ai-guard command registration object. */
  readonly command: AiGuardCommand = {
    description:
      "AI Guard review settings — decide what happens to the model's denials and uncertainty (session-scoped)",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.replace(/^\s+/, "");
      const spaceAt = trimmed.indexOf(" ");
      let items: { value: string; label: string }[];
      if (spaceAt < 0) {
        // First token: complete setting names followed by the save verbs.
        items = [
          ...this.#specs
            .filter((s) => s.name.startsWith(trimmed))
            .map((s) => ({
              value: s.name,
              label: s.description ? `${s.name} — ${s.description}` : s.name,
            })),
          ...SAVE_VERBS.map((v) => ({ value: v.text, label: v.text })),
        ].filter((i) => i.value.startsWith(trimmed));
      } else {
        // Second token: complete the named setting's values (and the reset action).
        const name = trimmed.slice(0, spaceAt);
        const valuePrefix = trimmed.slice(spaceAt + 1);
        const spec = this.#spec(name);
        if (!spec) return null;
        items = this.#options(spec)
          .filter((o) => o.text.startsWith(valuePrefix))
          .map((o) => ({ value: o.text, label: o.text }));
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!this.#deps.session.session?.config) {
        ctx.ui.notify(`${NOTIFY_PREFIX} no active session (config not loaded)`, "warning");
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      // Save verbs are surface-level actions, not setting values: they
      // dispatch before the setting path and need no picker UI.
      if (tokens[0] !== undefined) {
        const verb = SAVE_VERBS.find((v) => v.text === tokens[0]);
        if (verb) {
          this.#applyConfigSave(verb.target, ctx);
          return;
        }
      }

      // The picker paths need a dialog-capable UI (TUI or RPC); the direct
      // `/ai-guard <setting> <value>` form works everywhere.
      if (tokens.length < 2 && !ctx.hasUI) {
        ctx.ui.notify(
          `${NOTIFY_PREFIX} the settings menu needs an interactive UI — use /ai-guard <setting> <value>`,
          "error",
        );
        return;
      }

      // `/ai-guard <setting> [value]`
      if (tokens[0] !== undefined) {
        const spec = this.#spec(tokens[0]);
        if (!spec) {
          ctx.ui.notify(
            `${NOTIFY_PREFIX} unknown setting "${tokens[0]}" (${this.#specs.map((s) => s.name).join(", ")})`,
            "error",
          );
          return;
        }
        if (tokens[1] !== undefined) {
          const value = tokens.slice(1).join(" ");
          const option = this.#optionByText(spec, value);
          if (!option) {
            ctx.ui.notify(
              `${NOTIFY_PREFIX} invalid value "${value}" for ${spec.name} (${this.#options(spec)
                .map((o) => o.text)
                .join(", ")})`,
              "error",
            );
            return;
          }
          this.#applyOption(spec, option, ctx);
          return;
        }
        await this.#pickValue(spec, ctx);
        return;
      }

      // No args: settings menu, then the picked setting's value picker —
      // or one of the save actions, which apply directly.
      const specLabels = this.#specs.map((s) => this.#label(s));
      const labels = [...specLabels, ...SAVE_VERBS.map((v) => v.text)];
      const choice = await ctx.ui.select(
        "ai-guard settings — pick a setting to adjust, or save the current config",
        labels,
      );
      const verb = choice ? SAVE_VERBS.find((v) => v.text === choice) : undefined;
      if (verb) {
        this.#applyConfigSave(verb.target, ctx);
        return;
      }
      const spec = choice ? this.#specs[labels.indexOf(choice)] : undefined;
      if (spec) {
        await this.#pickValue(spec, ctx);
      }
    },
  };

  /** The ctrl+alt+g shortcut registration object (cycles the first setting). */
  readonly shortcut: AiGuardShortcut = {
    description: "Cycle ai-guard mode: manual → default → auto (session-scoped)",
    handler: (ctx) => {
      const spec = this.#specs[0];
      if (!spec || !this.#deps.session.session?.config) {
        ctx.ui.notify(`${NOTIFY_PREFIX} no active session (config not loaded)`, "warning");
        return;
      }
      const values = spec.values;
      const first = values[0];
      if (first === undefined) return;
      const current = this.#effective(spec) ?? first;
      const next = values[(values.indexOf(current) + 1) % values.length] ?? first;
      this.#apply(spec, next, ctx);
    },
  };

  /**
   * Restore every setting's override from the active branch (called at
   * session_start after the overrides reset, and at session_tree to
   * re-derive after branch navigation).
   *
   * @param reader - The session manager's branch-reading surface.
   */
  restore(reader: SessionBranchReader): void {
    for (const spec of this.#specs) {
      const restored = restoreSetting(spec.name, spec.values, reader);
      this.#writeOverride(spec, restored);
    }
  }

  /**
   * Sync the footer status line with the effective settings. Only
   * deviations render: the value itself (`auto`), with `(session)` while
   * an override is active (`auto (session)`). A spec whose effective value
   * is its {@link EnumSettingSpec.hiddenValue} contributes nothing, and an
   * all-hidden result clears the line — the shipped baseline (`default`)
   * never occupies a footer row.
   *
   * @param ctx - A UI context carrying setStatus (command/shortcut/event ctx).
   */
  syncFooter(ctx: AiGuardUiContext): void {
    if (!this.#deps.session.session?.config) return;
    const fragments: string[] = [];
    for (const spec of this.#specs) {
      const override = this.#readOverride(spec);
      const effective = this.#effective(spec) ?? "";
      if (effective === spec.hiddenValue) continue;
      fragments.push(override ? `${effective} (session)` : effective);
    }
    ctx.ui.setStatus(FOOTER_KEY, fragments.length > 0 ? fragments.join(" · ") : undefined);
  }

  /**
   * Clear the footer status line (session_shutdown).
   *
   * @param ctx - A UI context carrying setStatus.
   */
  clearFooter(ctx: AiGuardUiContext): void {
    ctx.ui.setStatus(FOOTER_KEY, undefined);
  }

  /**
   * The setting's menu label: `name — value (source)`.
   *
   * @param spec - The setting to label.
   * @returns The label string.
   */
  #label(spec: EnumSettingSpec): string {
    const override = this.#readOverride(spec);
    return override
      ? `${spec.name} — ${override} (session)`
      : `${spec.name} — ${this.#effective(spec)} (config)`;
  }

  /**
   * The spec's options: its enum values followed by the reset action.
   *
   * @param spec - The setting to list options for.
   * @returns The value options, then the reset action.
   */
  #options(spec: EnumSettingSpec): readonly SettingOption[] {
    return [
      ...spec.values.map((v) => ({ text: v, kind: "value" as const })),
      { text: "reset", kind: "reset" as const },
    ];
  }

  /**
   * Resolve a spelled option (`<value>` or `reset`) into its option record.
   *
   * @param spec - The setting to look the option up in.
   * @param text - The spelled option text.
   * @returns The matching option, or undefined.
   */
  #optionByText(spec: EnumSettingSpec, text: string): SettingOption | undefined {
    return this.#options(spec).find((o) => o.text === text);
  }

  /**
   * Apply an option: the reset action clears the override, a value writes
   * it.
   *
   * @param spec - The setting to apply the option to.
   * @param option - The resolved option (kind-discriminated).
   * @param ctx - The command/shortcut UI context.
   */
  #applyOption(spec: EnumSettingSpec, option: SettingOption, ctx: AiGuardUiContext): void {
    this.#apply(spec, option.kind === "reset" ? undefined : option.text, ctx);
  }

  /**
   * Persist the current effective config into the chosen layer. The loaded
   * config snapshot can't hot-swap inside this session, so the session
   * overrides stay as they are: the current session keeps behaving as
   * before, while new sessions start from the saved layer.
   *
   * @param target - Which layer to write (global / project).
   * @param ctx - The command UI context (notify).
   */
  #applyConfigSave(target: ConfigLayerTarget, ctx: AiGuardUiContext): void {
    const sessionConfig = this.#deps.session.session?.config;
    if (!sessionConfig) {
      // Unreachable through the command (the handler guards up front) — a
      // silent no-op here would hide a future caller's bug, so surface it.
      ctx.ui.notify(`${NOTIFY_PREFIX} no active session (config not loaded)`, "warning");
      return;
    }
    // The single projection point: defined overrides win over the loaded
    // snapshot — whatever key the overrides layer carries now or later.
    const result = this.#deps.saveConfig(
      target,
      effectiveConfig(sessionConfig, this.#deps.session.overrides),
    );
    if (result.error) {
      ctx.ui.notify(
        `${NOTIFY_PREFIX} could not save to ${target} config — ${result.error}`,
        "error",
      );
      return;
    }
    if (!result.changed) {
      ctx.ui.notify(
        `${NOTIFY_PREFIX} ${target} config already matches the current settings — nothing written`,
        "info",
      );
      return;
    }
    const created = result.created ? " (created)" : "";
    ctx.ui.notify(
      `${NOTIFY_PREFIX} current config saved to ${target} config${created}: ${result.path} — new sessions start from it; this session keeps its overrides`,
      "info",
    );
  }

  /**
   * The spec registered under `name`, or undefined.
   *
   * @param name - The setting name to look up.
   * @returns The matching spec, or undefined.
   */
  #spec(name: string): EnumSettingSpec | undefined {
    return this.#specs.find((s) => s.name === name);
  }

  /**
   * The spec's override value (undefined = config default).
   *
   * @param spec - The setting to read.
   * @returns The override value, or undefined.
   */
  #readOverride(spec: EnumSettingSpec): string | undefined {
    return this.#deps.session.overrides[spec.name];
  }

  /**
   * The effective value: session override first, then config default.
   *
   * @param spec - The setting to resolve.
   * @returns The effective value, or undefined without a config.
   */
  #effective(spec: EnumSettingSpec): string | undefined {
    return this.#readOverride(spec) ?? this.#configValue(spec);
  }

  /**
   * The config default for the spec's field.
   *
   * @param spec - The setting to read the config default of.
   * @returns The config value, or undefined without a session config.
   */
  #configValue(spec: EnumSettingSpec): string | undefined {
    const value = this.#deps.session.session?.config?.[spec.name];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * Write the spec's override through the stable overrides object.
   *
   * @param spec - The setting to write.
   * @param value - The override value (undefined = config default).
   */
  #writeOverride(spec: EnumSettingSpec, value: string | undefined): void {
    // The overrides invariant is "present ⇒ defined": undefined deletes,
    // so a reset never leaves a dead key that shadows the snapshot
    // projection back into the config value (see effectiveConfig).
    if (value === undefined) {
      delete this.#deps.session.overrides[spec.name];
      return;
    }
    // The one write-side cast: every value reaches this seam through
    // spec.values (command validation and restoreSetting both check
    // membership), so a string spec value IS a legal value of the dual-typed
    // field.
    this.#deps.session.overrides[spec.name] = value as AiGuardConfig[typeof spec.name];
  }

  /**
   * Apply a session-scoped change: write the override, persist it (null
   * records an explicit reset), and surface it (notify + footer).
   *
   * @param spec - The setting to apply a value of.
   * @param value - The new value, or undefined to reset to config.
   * @param ctx - The command/shortcut UI context for notify + setStatus.
   */
  #apply(spec: EnumSettingSpec, value: string | undefined, ctx: AiGuardUiContext): void {
    if (!this.#deps.session.session) return;
    this.#writeOverride(spec, value);
    // Persist into the session file so the override survives resume.
    persistSetting(this.#deps.appendEntry, spec.name, value ?? null);
    const effective = this.#effective(spec);
    if (value === undefined) {
      ctx.ui.notify(`${NOTIFY_PREFIX} ${spec.name}: ${effective} (config default)`, "info");
    } else {
      ctx.ui.notify(`${NOTIFY_PREFIX} ${spec.name}: ${value} (session override)`, "info");
    }
    this.syncFooter(ctx);
  }

  /**
   * Open the spec's value picker and apply the choice.
   *
   * @param spec - The setting to pick a value for.
   * @param ctx - The command UI context.
   */
  async #pickValue(spec: EnumSettingSpec, ctx: AiGuardUiContext): Promise<void> {
    const title = `${spec.name} — current: ${this.#label(spec)}`;
    const choice = await ctx.ui.select(
      title,
      this.#options(spec).map((o) => o.text),
    );
    if (choice !== undefined) {
      const option = this.#optionByText(spec, choice);
      if (option) {
        this.#applyOption(spec, option, ctx);
      }
    }
  }
}
