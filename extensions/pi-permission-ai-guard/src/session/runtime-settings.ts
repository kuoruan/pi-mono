/**
 * The runtime settings surface: everything a session-scoped setting needs
 * around its value — the /ai-guard command (menu, dispatch, completion),
 * the ctrl+alt+g cycle shortcut, footer projection, session-file
 * persistence, and restore from the active branch.
 *
 * The interface is deliberately registration-shaped: the extension wires
 * `command` / `shortcut` into pi.registerCommand / registerShortcut and
 * calls `restore` / `syncFooter` / `clearFooter` from its session event
 * handlers. Everything else — the command entry table, picker flows,
 * validation, notify + footer UX, the persistence format — is
 * implementation.
 *
 * Settings are enum-valued overrides over their same-named config field,
 * described declaratively by {@link EnumSettingSpec}: a setting named N
 * reads/writes `overrides.N`, falls back to `config.N`, persists under
 * key N, and offers `N <value>` + `N reset` on the command. Adding the
 * next setting is one spec entry here plus its schema/loader/docs — the
 * whole UX materializes from the spec. Action verbs (`save-*`, `breaker
 * reset`, `report`, `denied`) ride the same machinery as
 * {@link CommandEntry} rows — completion, menu, and dispatch traverse
 * the one table, so a verb is one entry, not four hand-built touch
 * points.
 */

import { basename } from "node:path";

import type {
  ExtensionShortcut,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import type { LogEntry } from "#src/audit/decision-log-reader.ts";
import { buildReportCandidates } from "#src/audit/report.ts";
import type { ConfigLayerTarget, SaveConfigFn } from "#src/config/config-layer.ts";
import type { AiGuardConfig } from "#src/config/config-schema.ts";
import { CYCLE_DESCRIPTION } from "#src/config/mode-table.ts";
import type { BreakerTier } from "#src/review/circuit-breaker.ts";
import type { DenyRecord, NotifyFn } from "#src/review/review-pipeline.ts";
import { NOTIFY_REASON_CEILING } from "#src/review/verdict-mode.ts";
import { truncateMiddle } from "#src/utils.ts";

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
  /** Setting name — persistence key, overrides key, config key. */
  readonly name: keyof SessionOverrides & keyof AiGuardConfig;
  /**
   * The command word (first token) when it differs from the persistence
   * key — the /ai-guard verb table is uniformly kebab-case (`notify-level`),
   * while config fields may be camelCase (`notifyLevel`). Absent = the
   * setting's own name (single-word settings need no alias).
   */
  readonly commandName?: string;
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
 * The read-only panels' collaborators (`report`, `denied`): the review-log read and the session's
 * deny history. Kept apart from {@link
 * RuntimeSettingsDeps} so the settings seam carries no report
 * facts (panel feedback rides the shared `notify` seam) — `denyHistory` is read through an accessor
 * because the live array is recreated at each session_start, after this object is wired once.
 */
export interface PanelDeps {
  /**
   * Reads the permission-review log's tail for the report command —
   * injected (production reads the real file; tests inject fixtures).
   * Returns undefined when the log cannot be read.
   */
  readDecisionLog: (home: string) => LogEntry[] | undefined;
  /** The user's home directory (log path resolution). */
  home: string;
  /** This session's model-gate deny history (empty when no session). */
  readDenyHistory: () => readonly DenyRecord[];
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

/** One pickable row of the settings menu: its label and its dispatch args. */
interface MenuRow {
  /** The picker label (settings show live state; actions their phrase). */
  readonly label: string;
  /** The arguments the picked entry runs with (a direction, or none). */
  readonly args: readonly string[];
}

/**
 * One row of the /ai-guard command table: a setting (its spec) or an
 * action verb. Completion, the settings menu, and dispatch all traverse
 * this one table — adding a verb is one entry, not four hand-built touch
 * points (a completion row, a dispatch branch, a method, a deps field).
 */
interface CommandEntry {
  /** The first token that selects this entry. */
  readonly name: string;
  /** The first-token completion label (static: what this is). */
  readonly completionLabel: string;
  /**
   * The settings-menu rows this entry contributes (none = not
   * menu-reachable; the read-only panels stay typed-verb-only, as
   * shipped). Settings contribute one row showing live state; a bare
   * action verb contributes its phrase and lets its picker ask the rest.
   */
  readonly menuRows?: () => MenuRow[];
  /** Second-token completion for the entry's argument grammar, if any. */
  readonly completeArgument?: (prefix: string) => CompletionItem[];
  /** Dispatch: the tokens that follow the entry's name. */
  readonly run: (args: readonly string[], ctx: AiGuardUiContext) => void | Promise<void>;
}

/** The settings-menu row for the save verb (its picker asks the target). */
const SAVE_MENU_LABEL = "save config";

/** The save-config verb's two valid targets (completion and picker order). */
const SAVE_TARGETS = ["global", "project"] as const;

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
  readonly #panels: PanelDeps;
  readonly #specs: readonly EnumSettingSpec[];
  /** The command table: settings first (spec order), then action verbs. */
  readonly #entries: readonly CommandEntry[];

  /**
   * @param deps - Settings collaborators: session surface, persistence, feedback.
   * @param panels - The read-only panels' collaborators (report / denied).
   * @param specs - The settings this extension exposes.
   */
  constructor(deps: RuntimeSettingsDeps, panels: PanelDeps, specs: readonly EnumSettingSpec[]) {
    this.#deps = deps;
    this.#panels = panels;
    this.#specs = specs;
    this.#entries = [...specs.map((spec) => this.#settingEntry(spec)), ...this.#actionEntries()];
  }

  /** The /ai-guard command registration object. */
  readonly command: AiGuardCommand = {
    description: "Adjust the ai-guard reviewer's session controls and browse its audit views",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.replace(/^\s+/, "");
      const spaceAt = trimmed.indexOf(" ");
      if (spaceAt < 0) {
        // First token: every entry in the table, name-prefixed.
        const items = this.#entries
          .filter((e) => e.name.startsWith(trimmed))
          .map((e) => ({ value: e.name, label: e.completionLabel }));
        return items.length > 0 ? items : null;
      }
      // Second token: the entry's argument grammar, when it has one.
      const entry = this.#entry(trimmed.slice(0, spaceAt));
      if (!entry?.completeArgument) return null;
      const items = entry.completeArgument(trimmed.slice(spaceAt + 1));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!this.#guardSessionConfig()) return;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const first = tokens[0];
      if (first === undefined) {
        await this.#menu(ctx);
        return;
      }
      const entry = this.#entry(first);
      if (!entry) {
        this.#deps.notify(
          `unknown command "${first}" (${this.#entries.map((e) => e.name).join(", ")})`,
          "error",
        );
        return;
      }
      await entry.run(tokens.slice(1), ctx);
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
      if (!spec || !this.#guardSessionConfig()) return;
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
   * The settings menu: one picker over the table's menu-reachable rows
   * (settings show live state; the save and breaker actions their
   * phrase), then the picked entry runs with its menu arguments. Labels
   * are plain text (only the FOOTER renders the highlighted value in
   * color), so resolution is an index into the same list.
   *
   * @param ctx - The command UI context (needs a dialog-capable UI).
   */
  async #menu(ctx: AiGuardUiContext): Promise<void> {
    if (!ctx.hasUI) {
      this.#deps.notify(
        "settings menu needs an interactive UI — use /ai-guard <setting> <value>",
        "error",
      );
      return;
    }
    const rows = this.#entries.flatMap((e) =>
      e.menuRows ? e.menuRows().map((r) => ({ entry: e, row: r })) : [],
    );
    const picked = await this.#pickItem(
      ctx,
      "ai-guard settings — pick a setting to adjust, save the current config, or reset the breaker",
      rows,
      (r) => r.row.label,
    );
    await picked?.entry.run(picked?.row.args, ctx);
  }

  /**
   * The entry registered under `name`, or undefined.
   *
   * @param name - The first token to look up.
   * @returns The matching entry, or undefined.
   */
  #entry(name: string): CommandEntry | undefined {
    return this.#entries.find((e) => e.name === name);
  }

  /**
   * The spec's command word — the kebab verb (falls back to the name).
   *
   * @param spec - The setting whose command word is wanted.
   * @returns The command word.
   */
  #commandWord(spec: EnumSettingSpec): string {
    return spec.commandName ?? spec.name;
  }

  /**
   * The setting's table row: `<word> [value|reset]` dispatches to the
   * option machinery, a bare `<word>` opens the value picker (the
   * direct form works everywhere; the picker needs a dialog UI).
   *
   * @param spec - The setting the row fronts.
   * @returns The command-table entry for the setting.
   */
  #settingEntry(spec: EnumSettingSpec): CommandEntry {
    const word = this.#commandWord(spec);
    return {
      name: word,
      completionLabel: spec.description ? `${word} — ${spec.description}` : word,
      menuRows: () => [{ label: this.#label(spec), args: [] }],
      completeArgument: (prefix) =>
        this.#options(spec)
          .filter((o) => o.text.startsWith(prefix))
          .map((o) => ({ value: o.text, label: o.text })),
      run: async (args, ctx) => {
        // The picker path needs a dialog-capable UI (TUI or RPC); the
        // direct `/ai-guard <setting> <value>` form works everywhere.
        if (args[0] === undefined) {
          if (!ctx.hasUI) {
            this.#deps.notify(
              "settings menu needs an interactive UI — use /ai-guard <setting> <value>",
              "error",
            );
            return;
          }
          await this.#pickValue(spec, ctx);
          return;
        }
        const value = args.join(" ");
        const option = this.#optionByText(spec, value);
        if (!option) {
          this.#deps.notify(
            `invalid value "${value}" for ${word} — valid values are ${this.#options(spec)
              .map((o) => o.text)
              .join("|")}`,
            "error",
          );
          return;
        }
        this.#applyOption(spec, option, ctx);
      },
    };
  }

  /**
   * The action verbs' table rows: save-config (global|project), breaker
   * reset, report, denied. Each entry owns its argument grammar (a fixed
   * argument, completed by prefix) and routes to its apply method.
   * save-config's menu row is bare: picking it opens the target
   * picker, the same two-step shape as a setting's value picker.
   *
   * @returns The action entries, command order.
   */
  #actionEntries(): CommandEntry[] {
    const configSave: CommandEntry = {
      name: "save-config",
      completionLabel: "save-config — persist the effective config for new sessions",
      menuRows: () => [{ label: SAVE_MENU_LABEL, args: [] }],
      completeArgument: (prefix) =>
        SAVE_TARGETS.filter((t) => t.startsWith(prefix)).map((t) => ({
          value: t,
          label: t,
        })),
      run: async (args, ctx) => {
        const target = args[0];
        if (target === "global" || target === "project") {
          this.#applyConfigSave(target);
          return;
        }
        if (target !== undefined) {
          this.#deps.notify("save-config takes one target — global or project", "error");
          return;
        }
        // A bare save-config (the menu's save row lands here too) opens
        // the target picker — the same two-step shape as a setting's
        // value picker. The direct form works everywhere.
        if (!ctx.hasUI) {
          this.#deps.notify(
            "save-config needs an interactive UI — use /ai-guard save-config <global|project>",
            "error",
          );
          return;
        }
        const choice = await ctx.ui.select("save config — pick a target layer", [...SAVE_TARGETS]);
        if (choice === "global" || choice === "project") {
          this.#applyConfigSave(choice);
        }
      },
    };
    return [
      configSave,
      {
        name: "breaker",
        completionLabel: "breaker — clear both trip tiers (cache and overrides untouched)",
        menuRows: () => [{ label: "reset circuit breaker", args: ["reset"] }],
        completeArgument: (prefix) =>
          "reset".startsWith(prefix) ? [{ value: "reset", label: "reset" }] : [],
        run: (args) => {
          if (args[0] !== "reset") {
            this.#deps.notify("breaker takes one action — reset", "error");
            return;
          }
          this.#applyBreakerReset();
        },
      },
      {
        name: "report",
        completionLabel: "report — suggest permission rules for repeated asks",
        run: (_args, ctx) => this.#applyReport(ctx),
      },
      {
        name: "denied",
        completionLabel: "denied — browse this session's model denies",
        run: (_args, ctx) => this.#applyDenied(ctx),
      },
    ];
  }

  /**
   * The setting's menu label: `word — value (source)`; the highlighted
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
    const word = this.#commandWord(spec);
    return override ? `${word} — ${value} (session)` : `${word} — ${value} (config)`;
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
    const sessionConfig = this.#guardSessionConfig();
    if (!sessionConfig) return;
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
    if (!this.#guardSessionConfig()) return;
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
   * The report action: aggregate the review log's repeated same-context
   * asks and offer copy-paste permission-rule fragments — evidence for the
   * operator, never an applied rule. Reads the log tail read-only.
   *
   * @param ctx - The command context (notify + optional picker).
   */
  async #applyReport(ctx: AiGuardUiContext): Promise<void> {
    const entries = this.#panels.readDecisionLog(this.#panels.home);
    if (entries === undefined) {
      this.#deps.notify("no review log found — nothing to report yet", "info");
      return;
    }
    const candidates = buildReportCandidates(entries);
    if (candidates.length === 0) {
      this.#deps.notify("no repeated same-context asks found in the recent review log", "info");
      return;
    }
    // Summary lines first (feedback channel — a direct answer to the typed
    // command, never level-gated), then the picker for the fragment.
    const top = candidates.slice(0, 10);
    for (const c of top.slice(0, 5)) {
      this.#deps.notify(`${c.occurrences}× ${c.target} (${c.surface})`, "info");
    }
    if (!ctx.hasUI) {
      this.#deps.notify("pass a picker-capable UI to browse the suggested rule fragments", "info");
      return;
    }
    const picked = await this.#pickItem(
      ctx,
      "ai-guard report — pick a suggestion to view its rule",
      top,
      (c) => `${c.occurrences}× ${c.target} (${c.surface})`,
    );
    if (!picked) return;
    this.#deps.notify(
      `suggested rule (confirm, then paste into pi-permission-system config) — ${picked.suggestedRule}`,
      "info",
    );
  }

  /**
   * The denied panel: this session's model-gate denies, most recent
   * first — what the reviewer itself refused. Read-only memory, no log
   * dependency (the panel is session-scoped by construction).
   *
   * @param ctx - The command context (notify + optional picker).
   */
  async #applyDenied(ctx: AiGuardUiContext): Promise<void> {
    const history = this.#panels.readDenyHistory();
    if (history.length === 0) {
      this.#deps.notify("no model-gate denies in this session", "info");
      return;
    }
    if (!ctx.hasUI) {
      this.#deps.notify(
        `pass a picker-capable UI to browse the ${history.length} deny record(s)`,
        "info",
      );
      return;
    }
    const recent = history.toReversed();
    // Labels carry a millisecond timestamp so repeated (target, surface)
    // pairs stay distinguishable — the pick-item seam's uniqueness
    // discipline (two model roundtrips cannot land in the same
    // millisecond).
    const record = await this.#pickItem(
      ctx,
      "ai-guard denied — pick a record to view its reason",
      recent,
      (d) =>
        `deny${d.riskLevel ? ` (${d.riskLevel})` : ""} — ${d.target} [${d.surface}] (${d.timestamp.slice(11, 23)})`,
    );
    if (!record) return;
    // The reason's notify copy rides the 200-char ceiling like every
    // other model-reason line (the audit record keeps the full text).
    const reason = record.reason
      ? ` — ${truncateMiddle(record.reason, NOTIFY_REASON_CEILING)}`
      : "";
    this.#deps.notify(`${record.timestamp} — ${record.surface} ${record.target}${reason}`, "info");
  }

  /**
   * The shared no-session guard: stands guard at the settings entry
   * points, WARNS the operator through notify when the session config is
   * absent (the side effect is the contract — the name says guard, not
   * read), and reports absence. Unreachable through the command (the
   * handler guards up front) at the apply call sites — a silent no-op
   * there would hide a future caller's bug, so the apply methods keep the
   * guard through this method.
   *
   * @returns The live session config, or undefined with a warning sent.
   */
  #guardSessionConfig(): AiGuardConfig | undefined {
    const config = this.#deps.session.session?.config;
    if (!config) {
      this.#deps.notify("no active session (config not loaded)", "warning");
      return undefined;
    }
    return config;
  }

  /**
   * The spec whose command word is `word`, or undefined.
   *
   * @param word - The command word to look up.
   * @returns The matching spec, or undefined.
   */
  #spec(word: string): EnumSettingSpec | undefined {
    return this.#specs.find((s) => this.#commandWord(s) === word);
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
    const word = this.#commandWord(spec);
    if (value === undefined) {
      this.#deps.notify(`${word} = ${effective} (config default)`, "info");
    } else {
      // Selecting the highlighted value deserves a warning-level notice
      // (plain text — the emphasis is footer-only).
      const highlighted = value === spec.highlightValue;
      this.#deps.notify(`${word} = ${value} (session override)`, highlighted ? "warning" : "info");
    }
    this.syncFooter(ctx);
  }

  /**
   * Pick an item through the label-based select seam: renders items, asks
   * the UI, maps the chosen label back to its item. The seam returns label
   * strings, so label↔item uniqueness is this helper's one discipline —
   * callers whose items can repeat (the deny panel's repeated targets)
   * must render distinguishing detail into the label.
   *
   * @param ctx - The command UI context (select-capable).
   * @param title - The picker title.
   * @param items - The items to choose among.
   * @param render - The label renderer (one per item).
   * @returns The picked item, or undefined on cancel.
   */
  async #pickItem<T>(
    ctx: AiGuardUiContext,
    title: string,
    items: readonly T[],
    render: (item: T) => string,
  ): Promise<T | undefined> {
    const labels = items.map(render);
    const choice = await ctx.ui.select(title, labels);
    return choice === undefined ? undefined : items[labels.indexOf(choice)];
  }

  /**
   * Open the spec's value picker and apply the choice.
   *
   * @param spec - The setting to pick a value for.
   * @param ctx - The command UI context.
   */
  async #pickValue(spec: EnumSettingSpec, ctx: AiGuardUiContext): Promise<void> {
    const title = `${this.#commandWord(spec)} — current: ${this.#label(spec)}`;
    // Picker lines carry the per-value detail (`strict — the reviewer's
    // allow is the only pass`) — plain text, resolved by item so the
    // pretty line never has to be parsed back.
    const options = this.#options(spec);
    const option = await this.#pickItem(ctx, title, options, (o) =>
      spec.optionDetails?.[o.text] ? `${o.text} — ${spec.optionDetails[o.text]}` : o.text,
    );
    if (option) {
      this.#applyOption(spec, option, ctx);
    }
  }
}
