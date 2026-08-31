/**
 * The machinery-failure taxonomy, single-sourced: the complete vocabulary
 * of "the reviewer's machinery failed" events, wherever they happen in
 * the pipeline.
 *
 * Two eras, one taxonomy:
 *
 * - **In-call** kinds (`ModelCallDeferKind`, owned by the parser it comes from): the call opened but
 *   produced no verdict — empty reply, unparseable text, timeout, provider error, or the model's
 *   own defer.
 * - **Pre-call** kinds (owned here, as values): the review never opened — the model could not
 *   resolve, auth failed, the transcript could not be stripped, or the ask yielded no review
 *   target.
 *
 * The pre-call values are single-sourced as an object constant so every
 * spelling site references one name: the kind strings flow into verdict
 * reasons, notify lines, and debug-stream records — a drifted literal
 * would fork the taxonomy silently. `ask.ts` derives its `no-target`
 * discriminant from the same value (one event, one string), and
 * `shortCircuit` types its reason by the union, so a raw literal at a
 * future call site stops compiling instead of drifting.
 */

import type { ModelCallDeferKind } from "./model-verdict.ts";

/**
 * The pre-call machinery-failure kinds, as values: the review never
 * opened. Members are named in camelCase, values are the wire/record
 * strings (kebab-case, as they appear in reasons and log records).
 */
export const PRE_CALL_MACHINERY_KINDS = {
  /** `registry.find` yielded no model for the configured provider/model. */
  modelUnresolved: "model-unresolved",
  /** `getApiKeyAndHeaders` failed (or threw, normalized upstream). */
  authFailed: "auth-failed",
  /** `stripTranscript` threw — no trusted-intent projection could be built. */
  transcriptError: "transcript-error",
  /** The ask qualified for review but no review target could be extracted. */
  noTarget: "no-target",
} as const;

/** One of the pre-call machinery-failure kinds. */
export type PreCallMachineryKind =
  (typeof PRE_CALL_MACHINERY_KINDS)[keyof typeof PRE_CALL_MACHINERY_KINDS];

/**
 * Any machinery failure, wherever it happens: the parser's in-call defer
 * kinds ∪ the pre-call kinds. The taxonomy's single statement —
 * consumers (`machineryDenyReason`, `machineryDeferNotice`, the
 * machinery-lane mapping) all speak this union.
 */
export type MachineryFailureKind = ModelCallDeferKind | PreCallMachineryKind;
