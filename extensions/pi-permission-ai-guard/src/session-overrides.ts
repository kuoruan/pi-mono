/**
 * Session-scoped runtime overrides over the config file, and the
 * "override beats config" resolution — the runtime-settings contract.
 */

import type { AiGuardConfig, Mode, NotifyThreshold } from "./config-schema.ts";

/**
 * Session-scoped runtime overrides over the config file. Set via the
 * `/ai-guard` command or the `ctrl+alt+g` shortcut; each change is appended
 * to the pi session file (custom entry, never LLM context) and restored on
 * resume. A new session starts from the config values.
 *
 * Invariant: an override key PRESENT means it carries a defined value.
 * Writers delete on undefined (the settings surface does); readers treat
 * "absent" and "undefined" as the same. This keeps the save snapshot
 * projection ({@link effectiveConfig}) from being shadowed by dead keys.
 */
export interface SessionOverrides {
  /** Guard mode for this session; undefined = use the config's mode. */
  mode?: Mode;
  /** Ambient-notify threshold for this session; undefined = config value. */
  notifyLevel?: NotifyThreshold;
}

/** The overridable config keys: name-matched fields of overrides and config. */
export type OverridableKey = keyof SessionOverrides & keyof AiGuardConfig;

/**
 * The "override beats config" rule, spelled once: the typed per-field
 * accessor every runtime reader of an overridable key routes through. A
 * new override field is compile-keyed here — a reader that forgets the
 * precedence stops type-checking instead of silently reading the config.
 * The full-snapshot projection ({@link effectiveConfig}) serves only the
 * save action.
 *
 * @param overrides - The stable session overrides object.
 * @param config - The validated config (required config yields a
 *   non-optional result).
 * @param key - The field to resolve.
 * @returns The effective field value.
 */
export function effectiveOverride<T extends OverridableKey>(
  overrides: SessionOverrides,
  config: AiGuardConfig,
  key: T,
): AiGuardConfig[T];
export function effectiveOverride<T extends OverridableKey>(
  overrides: SessionOverrides,
  config: AiGuardConfig | undefined,
  key: T,
): AiGuardConfig[T] | undefined;
export function effectiveOverride<T extends OverridableKey>(
  overrides: SessionOverrides,
  config: AiGuardConfig | undefined,
  key: T,
): AiGuardConfig[T] | undefined {
  // The indexed-access read is sound (both interfaces key the same field
  // name with the same value type) but TS cannot prove it across a generic
  // key once more than one field exists — cast on the single read seam.
  return (overrides[key] ?? config?.[key]) as AiGuardConfig[T] | undefined;
}

/**
 * The effective config: the loaded snapshot with every DEFINED override
 * applied — the save action's hole-snapshot projection (per-field reads
 * go through {@link effectiveOverride}).
 *
 * Keys whose override is undefined are skipped, so a reset (which deletes
 * the key) never lets a dead `mode: undefined` shadow the config value
 * into the saved layer file — the bug this projection exists to make
 * impossible.
 *
 * @param config - The validated loaded config.
 * @param overrides - The stable session overrides object.
 * @returns The materialized effective config. Values of override keys are
 *   runtime-validated upstream; legality for persistence is re-checked by
 *   the persist schema gate, not here.
 */
export function effectiveConfig(config: AiGuardConfig, overrides: SessionOverrides): AiGuardConfig {
  const result: Record<string, unknown> = { ...config };
  for (const key of Object.keys(overrides) as Array<keyof SessionOverrides>) {
    const value = overrides[key];
    if (value !== undefined) result[key] = value;
  }
  // The projection point carries the module's cast budget: SessionOverrides
  // keys are dynamic, so the rebuilt shape is re-asserted here, once.
  return result as AiGuardConfig;
}
