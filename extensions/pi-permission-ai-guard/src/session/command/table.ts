/**
 * The /ai-guard command table vocabulary: entries, menu rows, and the
 * name derivations. Completion, the settings menu, and dispatch all
 * traverse the one table — adding a verb is one entry, not a set of
 * hand-built touch points.
 */
import type { AiGuardUiContext } from "./ui-context.ts";

/** One pickable row of the settings menu: its label and its dispatch args. */
export interface MenuRow {
  readonly label: string;
  readonly args: readonly string[];
}

/**
 * One row of the /ai-guard command table: a setting (its spec) or an
 * action verb.
 */
export interface CommandEntry {
  /** The first token that selects this entry. */
  readonly name: string;
  /** The first-token completion label (static: what this is). */
  readonly completionLabel: string;
  /** The settings-menu rows this entry contributes (none = not menu-reachable). */
  readonly menuRows?: () => MenuRow[];
  /** Second-token completion for the entry's argument grammar, if any. */
  readonly completeArgument?: (prefix: string) => CompletionItem[];
  /** Dispatch: the tokens that follow the entry's name. */
  readonly run: (args: readonly string[], ctx: AiGuardUiContext) => void | Promise<void>;
}
/** A completion suggestion — one row of the command's argument completion. */
export interface CompletionItem {
  readonly value: string;
  readonly label: string;
}
/** One option in a setting's picker: an enum value, or the reset action. */
export type SettingOption = {
  readonly text: string;
  readonly kind: "value" | "reset";
};

/**
 * Re-segment a setting's name into its kebab-case command verb ("notifyLevel" → "notify-level").
 *
 * @param name - The setting's name.
 * @returns The kebab-case command verb.
 */
export function verbWord(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_]+/g, "-")
    .toLowerCase();
}

/**
 * Re-segment a setting's name into a lowercase space-separated phrase ("notifyLevel" → "notify
 * level").
 *
 * @param name - The setting's name.
 * @returns The display phrase.
 */
export function displayPhrase(name: string): string {
  return verbWord(name).replaceAll("-", " ");
}
