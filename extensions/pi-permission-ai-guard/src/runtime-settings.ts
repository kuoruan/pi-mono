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

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { AiGuardConfig } from "./config-schema.ts";
import {
  type SessionBranchReader,
  persistSetting,
  restoreSetting,
} from "./session-settings-store.ts";
import type { SessionOverrides } from "./session-state.ts";

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
   * A value not worth a footer line — the shipped baseline (e.g. "default").
   * When the effective value equals it, no fragment renders; an all-hidden
   * result clears the status line.
   */
  readonly hiddenValue?: string;
}

/**
 * The UI-context subset the settings surface uses — derived from the host's
 * UI context so the method signatures can't drift. Structurally satisfied
 * by `ExtensionCommandContext` / `ExtensionContext`.
 */
export interface AiGuardUiContext {
  /** Picker / notify / footer-status surface. */
  ui: Pick<ExtensionUIContext, "select" | "notify" | "setStatus">;
}

/** Context for the command handler: the UI subset plus the dialog-capability flag. */
export type AiGuardCommandContext = AiGuardUiContext & { hasUI: boolean };

/** The /ai-guard command registration object (pi.registerCommand's second argument). */
export interface AiGuardCommand {
  /** One-line command description. */
  description: string;
  /**
   * Completes setting names, then the named setting's values.
   * Returns `{ value, label }` items — structurally satisfies pi's
   * `AutocompleteItem[]` (its extra fields are optional).
   */
  getArgumentCompletions: (argumentPrefix: string) => { value: string; label: string }[] | null;
  /** Dispatch: direct form, value picker, or the settings menu. */
  handler: (args: string, ctx: AiGuardCommandContext) => Promise<void>;
}

/** The ctrl+alt+g shortcut registration object (pi.registerShortcut's second argument). */
export interface AiGuardShortcut {
  /** One-line shortcut description. */
  description: string;
  /** Cycles the first setting's value (wrap-around, config default as start). */
  handler: (ctx: AiGuardUiContext) => void;
}

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
}

/** Footer status key the settings line lives under. */
const FOOTER_KEY = "ai-guard";

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
    description: "Configure the AI guard link (settings menu; session-scoped)",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.replace(/^\s+/, "");
      const spaceAt = trimmed.indexOf(" ");
      let items: { value: string; label: string }[];
      if (spaceAt < 0) {
        // First token: complete setting names.
        items = this.#specs
          .filter((s) => s.name.startsWith(trimmed))
          .map((s) => ({ value: s.name, label: s.name }));
      } else {
        // Second token: complete the named setting's values.
        const name = trimmed.slice(0, spaceAt);
        const valuePrefix = trimmed.slice(spaceAt + 1);
        const spec = this.#spec(name);
        if (!spec) return null;
        items = this.#options(spec)
          .filter((v) => v.startsWith(valuePrefix))
          .map((v) => ({ value: v, label: v }));
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!this.#deps.session.session?.config) {
        ctx.ui.notify("ai-guard: no active session (config not loaded)", "warning");
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      // The picker paths need a dialog-capable UI (TUI or RPC); the direct
      // `/ai-guard <setting> <value>` form works everywhere.
      if (tokens.length < 2 && !ctx.hasUI) {
        ctx.ui.notify(
          "ai-guard: the settings menu needs an interactive UI — use /ai-guard <setting> <value>",
          "error",
        );
        return;
      }

      // `/ai-guard <setting> [value]`
      if (tokens[0] !== undefined) {
        const spec = this.#spec(tokens[0]);
        if (!spec) {
          ctx.ui.notify(
            `ai-guard: unknown setting "${tokens[0]}" (${this.#specs.map((s) => s.name).join(", ")})`,
            "error",
          );
          return;
        }
        if (tokens[1] !== undefined) {
          const value = tokens.slice(1).join(" ");
          if (!this.#options(spec).includes(value)) {
            ctx.ui.notify(
              `ai-guard: invalid value "${value}" for ${spec.name} (${this.#options(spec).join(", ")})`,
              "error",
            );
            return;
          }
          this.#apply(spec, value === "reset" ? undefined : value, ctx);
          return;
        }
        await this.#pickValue(spec, ctx);
        return;
      }

      // No args: settings menu, then the picked setting's value picker.
      const labels = this.#specs.map((s) => this.#label(s));
      const choice = await ctx.ui.select("ai-guard settings:", labels);
      const spec = choice ? this.#specs[labels.indexOf(choice)] : undefined;
      if (spec) {
        await this.#pickValue(spec, ctx);
      }
    },
  };

  /** The ctrl+alt+g shortcut registration object (cycles the first setting). */
  readonly shortcut: AiGuardShortcut = {
    description: "Cycle ai-guard mode (session-scoped)",
    handler: (ctx) => {
      const spec = this.#specs[0];
      if (!spec || !this.#deps.session.session?.config) {
        ctx.ui.notify("ai-guard: no active session (config not loaded)", "warning");
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
   * Picker options: the spec's values plus the reset action.
   *
   * @param spec - The setting to list options for.
   * @returns The value options (includes "reset").
   */
  #options(spec: EnumSettingSpec): readonly string[] {
    return [...spec.values, "reset"];
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
    return (this.#deps.session.overrides as Record<string, string | undefined>)[spec.name];
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
    const config = this.#deps.session.session?.config;
    const value = config ? (config as Record<string, unknown>)[spec.name] : undefined;
    return typeof value === "string" ? value : undefined;
  }

  /**
   * Write the spec's override through the stable overrides object.
   *
   * @param spec - The setting to write.
   * @param value - The override value (undefined = config default).
   */
  #writeOverride(spec: EnumSettingSpec, value: string | undefined): void {
    (this.#deps.session.overrides as Record<string, string | undefined>)[spec.name] = value;
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
      ctx.ui.notify(`ai-guard ${spec.name}: ${effective} (config default)`, "info");
    } else {
      ctx.ui.notify(`ai-guard ${spec.name}: ${value} (session override)`, "info");
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
    const choice = await ctx.ui.select(title, [...this.#options(spec)]);
    if (choice !== undefined) {
      this.#apply(spec, choice === "reset" ? undefined : choice, ctx);
    }
  }
}
