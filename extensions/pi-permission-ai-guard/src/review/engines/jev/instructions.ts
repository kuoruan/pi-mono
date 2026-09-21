import type { JsonValue } from "@typesafe-ai/sdk";

import type { JevQuestionId } from "#src/config/config-schema.ts";

/** An instruction overlay value: string, JSON object, or array (SDK EntryType minus null). */
export type JevInstructionValue = string | { [key: string]: JsonValue } | JsonValue[];

/** The per-question additions of an overlay object. */
export type JevOverlay = {
  background?: JevInstructionValue;
  questions?: Partial<Record<JevQuestionId, JevInstructionValue>>;
};

/**
 * `instructions` in Jev mode: a shorthand string (shared background for every
 * question) or an overlay object adding onto the built-ins — never replacing
 * them. DENY-Unless has no direct question by design: those categories are
 * intent-dependent, and intent-dependence is the (intent_match, risk) pair.
 */
export type JevInstructionsInput = string | JevOverlay | null | undefined;

/** A question's instructions as the SDK takes them: text alone, or text plus structured context. */
export type JevQuestionEntry = string | { question: string; context: JevInstructionValue };

/**
 * Narrow the structured member of {@link JevInstructionValue}.
 *
 * @param value - The overlay value to test.
 * @returns True for the JSON-object member.
 */
function isJsonRecord(value: JevInstructionValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge two structured contexts, the later layer winning per key.
 *
 * @param prior - The context already on the entry.
 * @param next - The overlay's context.
 * @returns The merged context (the later layer whole when the shapes differ).
 */
function mergeContext(prior: JevInstructionValue, next: JevInstructionValue): JevInstructionValue {
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
  entry: JevQuestionEntry,
  overlay: JevInstructionValue | undefined,
): JevQuestionEntry {
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
