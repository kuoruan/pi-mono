import type { JsonValue } from "@typesafe-ai/sdk";

import type { ClassifierQuestionId } from "#src/config/config-schema.ts";

/** An instruction overlay value: string, JSON object, or array (SDK EntryType minus null). */
type ClassifierInstructionValue = string | { [key: string]: JsonValue } | JsonValue[];

/**
 * The classifier lane's resolved instructions: the shared background plus the
 * per-question additions of an overlay object. Append-only by design — the
 * built-in reviewer background, questions, and criteria are the answer
 * contract the verdict thresholds are calibrated against, so nothing here
 * replaces them. The one merge exception is a per-question context whose
 * shape differs from the earlier layer's (see {@link mergeContext}); the
 * built-in background arrives as text, so it is never the layer dropped.
 * (DENY-Unless has no direct question by design: those categories are
 * intent-dependent, and intent-dependence is the (intent_match, risk) pair).
 */
export type ClassifierOverlay = {
  background?: ClassifierInstructionValue;
  questions?: Partial<Record<ClassifierQuestionId, ClassifierInstructionValue>>;
};

/** A question's instructions as the SDK takes them: text alone, or text plus structured context. */
export type ClassifierQuestionEntry =
  | string
  | { question: string; context: ClassifierInstructionValue };

/**
 * Narrow the structured member of {@link ClassifierInstructionValue}.
 *
 * @param value - The overlay value to test.
 * @returns True for the JSON-object member.
 */
function isJsonRecord(value: ClassifierInstructionValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge two structured contexts, the later layer winning per key.
 *
 * @param prior - The context already on the entry.
 * @param next - The overlay's context.
 * @returns The merged context (the later layer whole when the shapes differ).
 */
function mergeContext(
  prior: ClassifierInstructionValue,
  next: ClassifierInstructionValue,
): ClassifierInstructionValue {
  if (isJsonRecord(prior) && isJsonRecord(next)) return { ...prior, ...next };
  if (Array.isArray(prior) && Array.isArray(next)) return [...prior, ...next];
  return next;
}

/**
 * Layer one overlay value onto a question's entry. Text appends to the
 * question line; structured values merge with whatever the earlier layer put
 * in the context (records and arrays concatenate, a shape change replaces) —
 * so a per-question override adds to the shared background instead of
 * dropping it.
 *
 * @param entry - The question's current entry (base text, or text + context).
 * @param overlay - The overlay value, if any.
 * @returns The layered entry.
 */
export function applyOverlay(
  entry: ClassifierQuestionEntry,
  overlay: ClassifierInstructionValue | undefined,
): ClassifierQuestionEntry {
  if (overlay === undefined) return entry;
  if (typeof overlay === "string") {
    const question = `${
      typeof entry === "string" ? entry : entry.question
    }\n\nAdditional context: ${overlay}`;
    return typeof entry === "string" ? question : { ...entry, question };
  }
  if (typeof entry === "string") return { question: entry, context: overlay };
  return { ...entry, context: mergeContext(entry.context, overlay) };
}
