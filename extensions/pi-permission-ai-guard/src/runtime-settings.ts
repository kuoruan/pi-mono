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

import { basename } from "node:path";

import type {
  ExtensionShortcut,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import type { BreakerTier } from "./circuit-breaker.ts";
import type { ConfigLayerTarget, SaveConfigFn } from "./config-layer.ts";
import type { AiGuardConfig } from "./config-schema.ts";
import { CYCLE_DESCRIPTION } from "./mode-table.ts";
import type { NotifyFn } from "./review-pipeline.ts";
import { effectiveConfig, effectiveOverride, type SessionOverrides } from "./session-overrides.ts";
import {
  type SessionBranchReader,
  persistSetting,
  restoreSetting,
} from "./session-settings-store.ts";

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
  /**
   * The ctrl+alt+g cycle subset (the casual-reach surface). Absent = cycle
   * all values. The community pattern (Claude Code's Shift+Tab) keeps the
   * extremes out of casual reach — they stay selectable via the command
   * and picker, just not stumblable.
   */
  readonly cycleValues?: readonly string[];
  /**
   * A value that renders in warning red in the FOOTER status fragment —
   * e.g. the mode whose mapping auto-approves what the reviewer didn't.
   * The command surfaces (menu label, picker entry, change notification)
   * stay plain text. Emphasizing is presentation-only: matching and
   * persistence always use the value's plain text.
   */
  readonly highlightValue?: string;
  /**
   * Per-value one-line details for the picker (e.g. each mode's blurb).
   * Rendered as `value — detail` on the picker line only — the command
   * form and completions stay plain, and resolution is by option index,
   * never by parsing the pretty line.
   */
  readonly optionDetails?: Readonly<Record<string, string>>;
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

/**
 * A completion suggestion — one row of the command's argument completion.
 * Structurally the host's AutocompleteItem (pi-tui via RegisteredCommand);
 * the alignment is compile-checked where the command object satisfies
 * `AiGuardCommand` (its `getArgumentCompletions` carries the host's own
 * type, so a drift breaks the build rather than the runtime).
 */
export interface CompletionItem {
  /** The value inserted when the suggestion is accepted. */
  value: string;
  /** The row's display text. */
  label: string;
}

/** The settings' view of session state — {@link SessionLifecycle} satisfies this structurally. */
export interface SettingsSessionSurface {
  /** The live session's config, or undefined when no session is active. */
  readonly session: { readonly config: AiGuardConfig | undefined } | undefined;
  /** The stable overrides object (single write path, stable identity). */
  readonly overrides: SessionOverrides;
  /**
   * The `breaker reset` action's seam: clears the session's circuit
   * breaker and reports which tier was tripped. The breaker's tier
   * vocabulary crosses the seam only as this result — the surface never
   * touches the breaker itself.
   */
  readonly resetBreaker: () => BreakerTier | undefined;
}

/** Injectable collaborators the settings surface persists through. */
export interface RuntimeSettingsDeps {
  /** Session-state view: effective values come from overrides-then-config. */
  session: SettingsSessionSurface;
  /** Session-file append (persistence of setting changes). */
  appendEntry: (customType: string, data?: unknown) => void;
  /**
   * The settings surface's notify: command feedback through the session's
   * notify seam (prefix + disposed-runner guard live there). Feedback is a
   * synchronous answer to an explicit user action, so no level gate ever
   * applies (unlike the pipeline's ambient channel).
   */
  notify: NotifyFn;
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
 * Wrap text in terminal warning-red (bold) — used ONLY by the footer
 * status fragment (the command surfaces stay plain text). Width-safe in
 * pi-tui: its visibleWidth strips ANSI codes before measuring and
 * truncateToWidth re-attaches pending codes when truncating, so a
 * decorated status string is a supported shape, not a hack.
 *
 * @param text - The plain text to emphasize.
 * @returns The ANSI-wrapped text.
 */
function highlightText(text: string): string {
  return `\x1b[1;31m${text}\x1b[0m`;
}

/**
 * The save verbs, reserved at the command's top level: a setting spec must
 * never take one of these names (they'd shadow the action).
 */
const SAVE_VERBS = [
  { text: "save-to-global-config", label: "save global config", target: "global" as const },
  { text: "save-to-project-config", label: "save project config", target: "project" as const },
];

/** The picker label for the breaker-reset action (direct form: `breaker reset`). */
const BREAKER_RESET_LABEL = "reset circuit breaker";

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
      "AI Guard review settings — decide what happens to the reviewer's denials and uncertainty (session-scoped)",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.replace(/^\s+/, "");
      const spaceAt = trimmed.indexOf(" ");
      let items: CompletionItem[];
      if (spaceAt < 0) {
        // First token: complete setting names followed by the action
        // verbs (save verbs + breaker reset).
        items = [
          ...this.#specs
            .filter((s) => s.name.startsWith(trimmed))
            .map((s) => ({
              value: s.name,
              label: s.description ? `${s.name} — ${s.description}` : s.name,
            })),
          ...SAVE_VERBS.map((v) => ({ value: v.text, label: v.label })),
          ...(trimmed === "" || "breaker".startsWith(trimmed)
            ? [{ value: "breaker", label: "breaker — reset the circuit breaker" }]
            : []),
        ].filter((i) => i.value.startsWith(trimmed));
      } else {
        // Second token: complete the named setting's values (and the
        // breaker's reset action).
        const name = trimmed.slice(0, spaceAt);
        const valuePrefix = trimmed.slice(spaceAt + 1);
        if (name === "breaker") {
          return "reset".startsWith(valuePrefix) ? [{ value: "reset", label: "reset" }] : null;
        }
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
        this.#deps.notify("no active session (config not loaded)", "warning");
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      // Action verbs are surface-level, not setting values: they dispatch
      // before the setting path. `breaker reset` is two tokens because it
      // reads as a phrase; it is NOT the setting form (`breaker` is not a
      // spec name).
      if (tokens[0] === "breaker" && tokens[1] === "reset") {
        this.#applyBreakerReset();
        return;
      }

      // Save verbs are surface-level actions, not setting values: they
      // dispatch before the setting path and need no picker UI.
      if (tokens[0] !== undefined) {
        const verb = SAVE_VERBS.find((v) => v.text === tokens[0]);
        if (verb) {
          this.#applyConfigSave(verb.target);
          return;
        }
      }

      // The picker paths need a dialog-capable UI (TUI or RPC); the direct
      // `/ai-guard <setting> <value>` form works everywhere.
      if (tokens.length < 2 && !ctx.hasUI) {
        this.#deps.notify(
          "settings menu needs an interactive UI — use /ai-guard <setting> <value>",
          "error",
        );
        return;
      }

      // `/ai-guard <setting> [value]`
      if (tokens[0] !== undefined) {
        const spec = this.#spec(tokens[0]);
        if (!spec) {
          this.#deps.notify(
            `unknown setting "${tokens[0]}" (${this.#specs.map((s) => s.name).join(", ")})`,
            "error",
          );
          return;
        }
        if (tokens[1] !== undefined) {
          const value = tokens.slice(1).join(" ");
          const option = this.#optionByText(spec, value);
          if (!option) {
            this.#deps.notify(
              `invalid value "${value}" for ${spec.name} — valid values are ${this.#options(spec)
                .map((o) => o.text)
                .join("|")}`,
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
      // or one of the save/reset actions, which apply directly. Labels
      // are plain text (only the FOOTER renders the highlighted value in
      // color), so resolution is a plain match.
      const specLabels = this.#specs.map((s) => this.#label(s));
      const labels = [...specLabels, ...SAVE_VERBS.map((v) => v.label), BREAKER_RESET_LABEL];
      const choice = await ctx.ui.select(
        "ai-guard settings — pick a setting to adjust, save the current config, or reset the breaker",
        labels,
      );
      const verb = choice ? SAVE_VERBS.find((v) => v.label === choice) : undefined;
      if (verb) {
        this.#applyConfigSave(verb.target);
        return;
      }
      if (choice === BREAKER_RESET_LABEL) {
        this.#applyBreakerReset();
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
    // Generated from the ladder table's cycle membership — the description
    // cannot drift from the cycle it describes.
    description: `Cycle ai-guard mode: ${CYCLE_DESCRIPTION} (session-scoped)`,
    handler: (ctx) => {
      // The cycle anchors the MODE spec by name — specs is no longer a
      // one-element array, and "first" was a silent single-spec assumption.
      const spec = this.#spec("mode");
      if (!spec || !this.#deps.session.session?.config) {
        this.#deps.notify("no active session (config not loaded)", "warning");
        return;
      }
      // The cycle visits the CASUAL subset only (cycleValues) — the
      // command and picker cover the full value set.
      const values = spec.cycleValues ?? spec.values;
      const first = values[0];
      if (first === undefined) return;
      const current = this.#effective(spec);
      // An effective value outside the cycle subset (e.g. `strict` or
      // `permissive`) anchors to the subset's start on the next press.
      const index = current === undefined ? -1 : values.indexOf(current);
      const next = values[index + 1] ?? first;
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
   * deviations render: the value itself (`lenient`), with `(session)` while
   * an override is active (`lenient (session)`). A spec whose effective value
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
      const fragment = override ? `${effective} (session)` : effective;
      fragments.push(effective === spec.highlightValue ? highlightText(fragment) : fragment);
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
   * The setting's menu label: `name — value (source)`; the highlighted
   * value renders in warning red (presentation-only — matching stays on
   * the plain text).
   *
   * @param spec - The setting to label.
   * @returns The label string.
   */
  #label(spec: EnumSettingSpec): string {
    const override = this.#readOverride(spec);
    // Plain text — the warning-red emphasis is footer-only.
    const value = override ?? this.#effective(spec);
    return override ? `${spec.name} — ${value} (session)` : `${spec.name} — ${value} (config)`;
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
   */
  #applyConfigSave(target: ConfigLayerTarget): void {
    const sessionConfig = this.#deps.session.session?.config;
    if (!sessionConfig) {
      // Unreachable through the command (the handler guards up front) — a
      // silent no-op here would hide a future caller's bug, so surface it.
      this.#deps.notify("no active session (config not loaded)", "warning");
      return;
    }
    // The single projection point: defined overrides win over the loaded
    // snapshot — whatever key the overrides layer carries now or later.
    const result = this.#deps.saveConfig(
      target,
      effectiveConfig(sessionConfig, this.#deps.session.overrides),
    );
    if (result.error) {
      this.#deps.notify(`could not save to ${target} config — ${result.error}`, "error");
      return;
    }
    if (!result.changed) {
      this.#deps.notify(`${target} config already matches — nothing written`, "info");
      return;
    }
    const created = result.created ? " (created)" : "";
    this.#deps.notify(
      // Layer semantics, one line under budget: what the save feeds (new
      // sessions) and what it does NOT touch (this session's overrides).
      // The rarest fact — a higher layer can still shadow the saved value —
      // lives in the README's save-verbs section, not here.
      `saved to ${target} config (${basename(result.path)}${created}) — new sessions start from it; this session keeps current overrides`,
      "info",
    );
  }

  /**
   * The breaker-reset action (`/ai-guard breaker reset`): both tiers to
   * zero, notice re-armed. Pure counter mutation — the verdict cache and
   * every session override (mode, notifyLevel) are untouched, and the
   * confirmation says so (a later cached deny after a reset must not read
   * as "the reset didn't work").
   */
  #applyBreakerReset(): void {
    const sessionConfig = this.#deps.session.session?.config;
    if (!sessionConfig) {
      // Unreachable through the command (the handler guards up front) — a
      // silent no-op here would hide a future caller's bug, so surface it.
      this.#deps.notify("no active session (config not loaded)", "warning");
      return;
    }
    const tier = this.#deps.session.resetBreaker();
    const was =
      tier === "total"
        ? " (was total-tier tripped)"
        : tier === "consecutive"
          ? " (was tripped)"
          : "";
    this.#deps.notify(
      `circuit breaker cleared${was} — verdict cache and overrides untouched; reviews resume immediately`,
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
   * The effective value: session override first, then config default —
   * the typed accessor's spelling (see effectiveOverride in
   * session-overrides).
   *
   * @param spec - The setting to resolve.
   * @returns The effective value, or undefined without a config.
   */
  #effective(spec: EnumSettingSpec): string | undefined {
    // The one read-side cast, mirroring #writeOverride's write-side one:
    // the spec's values channel is string-typed, so the accessor's
    // precise field type widens to string at this single seam.
    return effectiveOverride(
      this.#deps.session.overrides,
      this.#deps.session.session?.config,
      spec.name,
    ) as string | undefined;
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
    // field. With more than one spec the key is a union and TS cannot
    // prove the value/key pair — erase through the string-keyed view.
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
      this.#deps.notify(`${spec.name} = ${effective} (config default)`, "info");
    } else {
      // Selecting the highlighted value deserves a warning-level notice
      // (plain text — the emphasis is footer-only).
      const highlighted = value === spec.highlightValue;
      this.#deps.notify(
        `${spec.name} = ${value} (session override)`,
        highlighted ? "warning" : "info",
      );
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
    // Picker lines carry the per-value detail (`strict — the reviewer's
    // allow is the only pass`) — plain text, resolved by index so the
    // pretty line never has to be parsed back.
    const options = this.#options(spec);
    const labels = options.map((o) =>
      spec.optionDetails?.[o.text] ? `${o.text} — ${spec.optionDetails[o.text]}` : o.text,
    );
    const choice = await ctx.ui.select(title, labels);
    const option = choice !== undefined ? options[labels.indexOf(choice)] : undefined;
    if (option) {
      this.#applyOption(spec, option, ctx);
    }
  }
}
