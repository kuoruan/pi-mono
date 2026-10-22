/**
 * The resolved mode policy — what the pipeline actually maps against.
 *
 * Three surfaces ask different questions about a mode, and each used to index
 * the built-in table directly: the verdict mapping (cut lines), the pre-call
 * machinery gates (the failure lane), and the settings surface (which values
 * the casual cycle visits and which one renders in warning red). A `custom`
 * mode has no table row, so the answers are resolved once, after parsing, and
 * carried as this policy: nothing downstream indexes a table by a value that
 * might not be in it.
 */

import type { VerdictOrigin } from "#src/model/model-verdict.ts";

import type { AiGuardConfig, BuiltinMode, IrreversibleRuling, Mode } from "./config-schema.ts";
import { BUILTIN_MODE_VALUES, MODE_VALUES } from "./config-schema.ts";
import { CYCLE_MODE_VALUES, MODE_TABLE } from "./mode-table.ts";
import { type ModeCuts, hasNoAskBand, sameBands } from "./suspicion.ts";

/** The effective disposition policy: the mode name plus the cuts it draws. */
export interface ModePolicy {
  /** The configured mode value (`custom` included). */
  mode: Mode;
  /** The effective cut lines — the built-in row's, or the custom pair's. */
  cuts: ModeCuts;
  /** How a review that produced no verdict is disposed of (never allow). */
  onReviewFailure: VerdictOrigin;
  /** How a floored allow is disposed of (`defer` on every built-in rung). */
  onIrreversibleEffect: IrreversibleRuling;
}

/**
 * A ladder-owned finding about the mode configuration. `error` means the
 * configuration cannot be honoured and the resolver fell back to a built-in
 * rung; `warning` means the configuration is legal but has no effect or is
 * worth knowing. Deliberately not the loader's `ConfigIssue`: the loader
 * imports this module, never the reverse.
 */
export interface ModePolicyIssue {
  /** The config field the finding is about. */
  path: "mode" | "customMode";
  /** The finding, in operator language. */
  message: string;
  /** Whether the setting had to be refused (`error`) or is merely inert. */
  severity: "error" | "warning";
}

/** The resolver's answer: the policy to run, plus what the operator must know. */
export interface ModeResolution {
  policy: ModePolicy;
  /** The built-in rung the resolver fell back to, when `custom` was unusable. */
  fallbackTo?: BuiltinMode;
  issues: ModePolicyIssue[];
}

/** The two config fields the resolver reads. */
export type ModeConfig = Pick<AiGuardConfig, "mode" | "customMode">;

/**
 * The built-in row's policy.
 *
 * @param mode - A built-in mode value.
 * @returns The policy drawn from the ladder table.
 */
function builtinPolicy(mode: BuiltinMode): ModePolicy {
  const row = MODE_TABLE[mode];
  // Built-in rungs always confirm: the invariant the live round established
  // stays a property of the shipped ladder, and only an operator who writes a
  // custom row can choose otherwise.
  return {
    mode,
    cuts: row.cuts,
    onReviewFailure: row.onReviewFailure,
    onIrreversibleEffect: "defer",
  };
}

/**
 * The built-in rung a custom row reproduces exactly, if any. The irreversible
 * axis joins the comparison: a custom row that draws a built-in ladder but
 * rules the floor differently is not that rung.
 *
 * @param cuts - The custom cut lines.
 * @param onReviewFailure - The custom failure lane.
 * @param onIrreversibleEffect - The custom irreversible axis.
 * @returns The matching built-in mode, or undefined.
 */
function redundantRow(
  cuts: ModeCuts,
  onReviewFailure: VerdictOrigin,
  onIrreversibleEffect: IrreversibleRuling,
): BuiltinMode | undefined {
  // Only a defer ruling can reproduce a built-in row: every built-in rung
  // rules defer, so anything else is not that rung whatever its cuts.
  if (onIrreversibleEffect !== "defer") return undefined;
  return BUILTIN_MODE_VALUES.find(
    (m) => sameBands(MODE_TABLE[m].cuts, cuts) && MODE_TABLE[m].onReviewFailure === onReviewFailure,
  );
}

/**
 * Resolve the configured mode into the policy the pipeline runs, repairing an
 * unusable `custom` row rather than failing the whole config: `mode: "custom"`
 * with no `customMode` block falls back to `default` with an error-level
 * finding, because refusing to load would take the guard offline over a mode
 * choice.
 *
 * @param config - The validated config's mode fields.
 * @returns The effective policy, the fallback (if any), and the findings.
 */
export function resolveModePolicy(config: ModeConfig): ModeResolution {
  const { mode, customMode } = config;
  const issues: ModePolicyIssue[] = [];

  if (mode !== "custom") {
    if (customMode !== null) {
      issues.push({
        path: "customMode",
        message: `customMode is ignored while mode is "${mode}"; it is only read when mode is "custom"`,
        severity: "warning",
      });
    }
    return { policy: builtinPolicy(mode), issues };
  }

  if (customMode === null) {
    issues.push({
      path: "mode",
      message:
        'mode "custom" needs a customMode block with allowThrough, denyFrom, and onReviewFailure; running "default" instead',
      severity: "error",
    });
    return { policy: builtinPolicy("default"), fallbackTo: "default", issues };
  }

  const cuts: ModeCuts = { allowThrough: customMode.allowThrough, denyFrom: customMode.denyFrom };
  const redundant = redundantRow(cuts, customMode.onReviewFailure, customMode.onIrreversibleEffect);
  if (redundant !== undefined) {
    issues.push({
      path: "customMode",
      message: `customMode draws exactly the same ladder as the built-in "${redundant}"; set mode "${redundant}" instead`,
      severity: "warning",
    });
  }
  return {
    policy: {
      mode: "custom",
      cuts,
      onReviewFailure: customMode.onReviewFailure,
      onIrreversibleEffect: customMode.onIrreversibleEffect,
    },
    issues,
  };
}

/**
 * The casual ctrl+alt+g cycle: the built-in rungs it visits, plus `custom`
 * last when the config defines one — an operator can only cycle into a mode
 * that resolves, so an unconfigured `custom` never becomes a stop that has
 * nothing behind it.
 *
 * @param config - The validated config's mode fields.
 * @returns The cycle, in press order.
 */
export function cycleValues(config: ModeConfig): readonly Mode[] {
  return config.customMode === null ? CYCLE_MODE_VALUES : [...CYCLE_MODE_VALUES, "custom"];
}

/**
 * Whether a policy renders in warning red on the footer: the cycle can reach
 * it and it never asks, which is exactly the mode an operator can land in
 * without ever seeing a dialog.
 *
 * @param policy - The effective policy.
 * @param config - The validated config's mode fields.
 * @returns True when the footer should emphasize this value.
 */
export function isHighlighted(policy: ModePolicy, config: ModeConfig): boolean {
  return cycleValues(config).includes(policy.mode) && hasNoAskBand(policy.cuts);
}

/**
 * The mode values the settings picker offers: every built-in rung, plus
 * `custom` when the config defines it.
 *
 * @param config - The validated config's mode fields.
 * @returns The selectable values, ladder order.
 */
export function selectableModes(config: ModeConfig): readonly Mode[] {
  return config.customMode === null ? MODE_VALUES.filter((m) => m !== "custom") : [...MODE_VALUES];
}
