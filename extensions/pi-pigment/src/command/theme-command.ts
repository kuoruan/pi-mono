/**
 * The `/pigment` command (ADR 0006): manual conversion of the user's theme
 * sources. A bare `/pigment` opens the subcommand picker (currently
 * `convert` alone); picking it opens a TUI selector of the UNCONVERTED
 * sources; `/pigment convert <stem>` converts one directly. Outputs land
 * NEXT TO their sources (themes/pigment-<stem>.json) — visible,
 * inspectable, self-sufficient.
 *
 * The subcommand table follows the pi-permission-ai-guard single-table
 * discipline: argument completion, the bare-invocation picker, and
 * dispatch all traverse ONE entries list — adding the next subcommand is
 * one entry here (name, one-line description, optional argument grammar,
 * behavior), not four hand-built touch points. An entry's description
 * doubles as its completion label and its picker row.
 *
 * The convert picker lists the sources once; load failures surface on the
 * issues channel, and the picked stem takes the ordinary convert path.
 *
 * A converted source (pigment-<stem>.json exists) drops out of the
 * converter's candidate list only — it KEEPS resolving as a `syntaxTheme`
 * token override (conversion never retires the source; referencing the
 * product by name gets a directed issue — see theme-resolver). The source
 * FILE stays: the precise pipeline's input (ours-detection loads it for
 * full tokenColors) and the re-conversion source. Deleting the OUTPUT
 * re-lists the source; deleting the SOURCE
 * leaves the output standing alone (external theme path — its nine colors
 * still derive well).
 */

import {
  getAgentDir,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { ThemeEnv } from "#src/theme/theme-file.ts";
import {
  convertThemes,
  getUserThemeEnv,
  listConvertCandidateEntries,
  listConvertCandidates,
  piNameForUserStem,
} from "#src/theme/user-themes.ts";

/**
 * The UI-context subset the `/pigment` command consumes — DERIVED from the
 * SDK's own command context (the narrowing keeps run signatures from
 * drifting beyond picker + feedback, and a host type change breaks the
 * build instead of the runtime).
 */
type PigmentUiContext = Pick<ExtensionCommandContext, "hasUI" | "cwd"> & {
  /** The picker / notification surface. */
  ui: Pick<ExtensionUIContext, "select" | "notify">;
};

/** The feedback channel subcommand runs report through (the SDK notify seam). */
type ReportFn = ExtensionUIContext["notify"];

/**
 * One `/pigment` subcommand — the single place defining its name, its
 * one-line description (the completion label AND the picker row), its
 * argument grammar, and its behavior.
 */
interface Subcommand {
  /** The first token that selects this subcommand. */
  readonly name: string;
  /** One-line what-this-does — shown in completions and the picker. */
  readonly description: string;
  /** The argument completion for the tokens after the name; absent = none. */
  readonly completeArgument?: (prefix: string, env: ThemeEnv) => AutocompleteItem[] | null;
  /** Run the subcommand with the tokens after its name. */
  readonly run: (
    args: readonly string[],
    env: ThemeEnv,
    ctx: PigmentUiContext,
    report: ReportFn,
  ) => Promise<void>;
}

/**
 * The subcommand's picker/completion label: `name — description`.
 *
 * @param sub - The subcommand to label.
 * @returns The label string.
 */
function subcommandLabel(sub: Subcommand): string {
  return `${sub.name} — ${sub.description}`;
}

/** The `convert` subcommand: manual conversion of user theme sources. */
const convertSubcommand: Subcommand = {
  name: "convert",
  description: "convert a TextMate theme file into a registered pi theme",
  /**
   * After the name: unconverted-source stems, replacing the whole args.
   *
   * @param prefix - The typed stem prefix.
   * @param env - The environment (theme discovery roots).
   * @returns The matching stem completions, or null when none.
   */
  completeArgument: (prefix, env) => {
    const stemPrefix = prefix.trimStart();
    const matches = listConvertCandidates(env).filter((stem) => stem.startsWith(stemPrefix));
    return matches.length > 0
      ? matches.map((stem) => ({ value: `convert ${stem}`, label: `convert ${stem}` }))
      : null;
  },
  run: async (args, env, ctx, report) => {
    const stem = args.join(" ");
    // No stem: the TUI selector over the unconverted sources.
    let target = stem === "" ? undefined : stem;
    if (target === undefined) {
      // The candidate list annotates each source's config layer —
      // `stem (project)` / `stem (global)` — resolved by index (labels
      // are never parsed back).
      // Load failures surface on the issues channel; the picked stem
      // takes the ordinary convert path.
      const { entries, issues } = listConvertCandidateEntries(env);
      for (const issue of issues) report(issue.message, "warning");
      if (entries.length === 0) {
        report("no theme sources to convert (drop TextMate theme files into themes/ first)");
        return;
      }
      const labels = entries.map((entry) => `${entry.stem} (${entry.layer})`);
      if (!ctx.hasUI) {
        report(`headless mode — name a stem: ${labels.join(", ")}`);
        return;
      }
      const choice = await ctx.ui.select("Convert theme", labels);
      if (choice === undefined) return; // cancelled
      target = entries[labels.indexOf(choice)]?.stem;
      if (target === undefined) return; // unreachable (options ARE the labels)
    }

    // The whole convert path is fallible at the FS layer (unreadable
    // dirs, disk-full writes) — a thrown handler would surface as an
    // unhandled rejection at pi's command layer, not as the issues
    // channel this command's contract promises.
    try {
      const { results, issues } = convertThemes(env, [target]);
      for (const issue of issues) report(issue.message);
      const result = results[0];
      if (result === undefined) return;
      if (result.ok) {
        report(
          `converted ${result.stem} → themes/${piNameForUserStem(result.stem)}.json (/reload to register)`,
        );
      } else if (result.reason === "not-found") {
        report(
          `no theme source "${target}" (or it is already converted — its pigment-*.json exists)`,
        );
      } else {
        report(`"${target}" failed to convert — see the issues above`);
      }
    } catch (error) {
      report(`convert failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/** The subcommand table, in picker and completion order. */
const SUBCOMMANDS: readonly Subcommand[] = [convertSubcommand];

/** The known subcommand names — the error/fallback listing (table-derived). */
const KNOWN_SUBCOMMANDS = SUBCOMMANDS.map((sub) => sub.name).join(", ");

/**
 * The subcommand registered under `name`, or undefined.
 *
 * @param name - The first token to look up.
 * @returns The matching subcommand, or undefined.
 */
function subcommandOf(name: string): Subcommand | undefined {
  return SUBCOMMANDS.find((sub) => sub.name === name);
}

/**
 * Register the `/pigment` command (called once at extension setup).
 *
 * @param pi - The extension API.
 */
export function registerPigmentCommand(pi: {
  registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => void;
}): void {
  pi.registerCommand("pigment", {
    description: "Convert TextMate theme files into registered pi themes",
    getArgumentCompletions: (argumentPrefix: string) => {
      const trimmed = argumentPrefix.trimStart();
      const spaceAt = trimmed.indexOf(" ");
      if (spaceAt < 0) {
        // First token: the subcommand names, labeled with their purpose.
        const items = SUBCOMMANDS.filter((sub) => sub.name.startsWith(trimmed)).map((sub) => ({
          value: sub.name,
          label: subcommandLabel(sub),
        }));
        return items.length > 0 ? items : null;
      }
      // Past the name: the subcommand's argument grammar, when it has one.
      const entry = subcommandOf(trimmed.slice(0, spaceAt));
      if (!entry?.completeArgument) return null;
      // The session's recorded env is the truth remote/RPC modes may not
      // share with process.cwd(); before the first session_start there is
      // no session yet — the process env stands in.
      const env: ThemeEnv = getUserThemeEnv() ?? { cwd: process.cwd(), agentDir: getAgentDir() };
      return entry.completeArgument(trimmed.slice(spaceAt + 1), env);
    },
    handler: async (args: string, ctx: PigmentUiContext) => {
      const report: ReportFn = (message, type = "info"): void => {
        if (ctx.hasUI) {
          ctx.ui.notify(`[pi-pigment] ${message}`, type);
        } else {
          console.error(`[pi-pigment] ${message}`);
        }
      };
      const env: ThemeEnv = { cwd: ctx.cwd, agentDir: getAgentDir() };
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const first = tokens[0];
      if (first === undefined) {
        // The bare command: the subcommand picker (headless prints the
        // direct form instead — no dialogs without a UI).
        if (!ctx.hasUI) {
          report(
            `subcommand picker needs an interactive UI — use /pigment ${KNOWN_SUBCOMMANDS}`,
            "warning",
          );
          return;
        }
        const labels = SUBCOMMANDS.map(subcommandLabel);
        const choice = await ctx.ui.select("pi-pigment — pick a subcommand", labels);
        if (choice === undefined) return; // cancelled
        await SUBCOMMANDS[labels.indexOf(choice)].run([], env, ctx, report);
        return;
      }
      const entry = subcommandOf(first);
      if (entry === undefined) {
        report(`unknown subcommand "${first}" — known: ${KNOWN_SUBCOMMANDS}`, "error");
        return;
      }
      await entry.run(tokens.slice(1), env, ctx, report);
    },
  });
}
