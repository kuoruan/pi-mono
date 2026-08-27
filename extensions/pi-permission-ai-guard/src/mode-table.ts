/**
 * The mode ladder — the single source of truth for every OPERATIONAL fact
 * about a mode value: the verdict lanes (imported by verdict-mode), the
 * casual-cycle membership, the warning-red emphasis, and the
 * config-surprise warnings (imported by config-layer).
 *
 * Deliberate exceptions live OUTSIDE the table: the Mode union itself
 * (config-schema — it is the config contract), and the curated human prose
 * in README/CONTEXT and the JSON schema description (different readers —
 * generated prose would serve them worse). Those stay hand-edited; the
 * config-surface drift test pins the mechanical pairs.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { MODE_VALUES, type AiGuardConfig, type Mode } from "./config-schema.ts";
import type { VerdictOrigin } from "./model-verdict.ts";

/** The verdict lanes a mode disposes (the leniency ladder, strictest first). */
export interface ModeLanes {
  /** Soft-tier deny (low|medium) target. */
  softDeny: AuthorizerVerdict["kind"];
  /** The model's own uncertainty target. */
  modelDefer: AuthorizerVerdict["kind"];
  /**
   * Machinery-failure target — narrower by type: a broken reviewer never maps to allow. The
   * `permissive` value tightens back to `deny` — the ladder's one non-monotone cell, contract over
   * monotonicity: a defer would need a dialog the zero-interruption contract forbids, and a broken
   * reviewer must not rubber-stamp.
   */
  machinery: VerdictOrigin;
}

/** Per-mode operational facts for the settings/UX surfaces. */
export interface ModeFacts {
  /** One-line what-this-mode-changes blurb (completion labels, docs seed). */
  blurb: string;
  /** Whether the ctrl+alt+g casual cycle visits this mode. */
  inCycle: boolean;
  /** Whether the footer renders this value in warning red (command surfaces stay plain). */
  emphasize: boolean;
}

/** One mode's row in the ladder table. */
export interface ModeEntry {
  /** The verdict lanes (soft deny / model defer / machinery). */
  lanes: ModeLanes;
  /** The operational facts for the settings/UX surfaces. */
  facts: ModeFacts;
}

/** The ladder table, strictest first. */
export const MODE_TABLE: Record<Mode, ModeEntry> = {
  strict: {
    lanes: { softDeny: "deny", modelDefer: "deny", machinery: "deny" },
    facts: {
      blurb: "the reviewer's allow is the only pass",
      inCycle: false,
      emphasize: false,
    },
  },
  default: {
    lanes: { softDeny: "deny", modelDefer: "defer", machinery: "defer" },
    facts: {
      blurb: "deny is final; uncertainty asks (the shipped behavior)",
      inCycle: true,
      emphasize: false,
    },
  },
  advisory: {
    lanes: { softDeny: "defer", modelDefer: "defer", machinery: "defer" },
    facts: {
      blurb: "you decide everything except the reviewer's hardest calls",
      inCycle: true,
      emphasize: false,
    },
  },
  lenient: {
    lanes: { softDeny: "defer", modelDefer: "allow", machinery: "defer" },
    facts: {
      blurb: "only the reviewer's active alarms ask you",
      inCycle: true,
      emphasize: false,
    },
  },
  permissive: {
    lanes: { softDeny: "allow", modelDefer: "allow", machinery: "deny" },
    facts: {
      blurb: "only clear high-danger requests are blocked",
      inCycle: false,
      emphasize: true,
    },
  },
};

/**
 * The casual ctrl+alt+g cycle, derived from the table's inCycle flags in
 * ladder order (the community pattern: the extremes stay out of casual
 * reach — set explicitly via the command or picker).
 */
export const CYCLE_MODE_VALUES: readonly Mode[] = MODE_VALUES.filter(
  (m) => MODE_TABLE[m].facts.inCycle,
);

/** The single emphasized value (renders in warning red), or undefined. */
export const EMPHASIZED_MODE: Mode | undefined = MODE_VALUES.find(
  (m) => MODE_TABLE[m].facts.emphasize,
);

/**
 * Each mode's one-line blurb, keyed by the mode name — the picker's
 * per-value descriptions ("strict — the reviewer's allow is the only
 * pass"). Derived from the table like the cycle subset, so the picker
 * labels cannot drift from the modes they describe.
 */
export const MODE_BLURBS: Readonly<Record<string, string>> = Object.fromEntries(
  MODE_VALUES.map((m) => [m, MODE_TABLE[m].facts.blurb]),
);

/** The generated shortcut description's cycle part ("default → advisory → lenient"). */
export const CYCLE_DESCRIPTION: string = CYCLE_MODE_VALUES.join(" → ");

/**
 * The config surprise warnings: mode × breaker-verdict combinations where
 * the breaker can interrupt the human (the reviewer-untrusted escape
 * valve) — legal but worth surfacing. Owned by the ladder module: the
 * generic JSONC layer should not carry ladder semantics.
 *
 * @param config - The validated config.
 * @returns Warning issues, if any (path is always "mode").
 */
/**
 * A ladder-owned config surprise warning. Deliberately NOT the loader's
 * `ConfigIssue` — importing it here would create a type-level edge back
 * into the consuming layer (the loader imports the ladder, never the
 * reverse); the shape is structurally compatible.
 */
export interface ModeWarning {
  /** The offending config field ("mode"). */
  path: "mode";
  /** The surprise, in operator language. */
  message: string;
}

export function modeWarnings(config: AiGuardConfig): ModeWarning[] {
  if (
    (config.mode === "strict" || config.mode === "permissive") &&
    config.circuitBreaker.verdict === "defer"
  ) {
    return [
      {
        path: "mode",
        message: `mode "${config.mode}" + circuitBreaker.verdict "defer": the breaker interrupts the human when it trips (reviewer-untrusted escape valve).`,
      },
    ];
  }
  return [];
}
