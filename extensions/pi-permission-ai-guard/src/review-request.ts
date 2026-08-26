/**
 * Immutable per-ask review context — the single seam between permission
 * details and both prompt rendering and cache identity. Any fact that affects
 * a verdict must live here.
 */

import type { PromptRequestFacts } from "@gotgenes/pi-permission-system";

import type { AskContext } from "./ask.ts";
import { normalizeEmpty } from "./utils.ts";

export interface ReviewRequestContext {
  readonly ask: AskContext;
  target: string;
}

/**
 * The exclusion doctrine, as compile-time tripwires.
 *
 * The cache identity keys on a deliberate subset. Every OTHER
 * decision-adjacent fact is excluded for a REASON — the two records below
 * are exhaustive by construction: add a field to `AskContext`, or upstream
 * adds one to `PromptRequestFacts`, and the corresponding `Record` stops
 * compiling until the new field is either keyed or documented here. The
 * "annotations are always empty" and "administrative labels are noise"
 * assumptions can then never go stale silently.
 */

/** AskContext fields the cache identity reads from. */
type KeyedAskFields =
  | "kind"
  | "request"
  | "fullCommand"
  | "flaggedElements"
  | "toolInputPreview"
  | "readPath"
  | "resolvedAlias"
  | "canonicalBoundary"
  | "workingDirectory";

/** Upstream request facts the cache identity keys on (via the material below). */
type KeyedRequestFacts = "value" | "commandContext" | "executedUnit";

/** Every other AskContext field — excluded by doctrine, one entry each. */
export const EXCLUDED_ASK_FIELDS: Record<Exclude<keyof AskContext, KeyedAskFields>, string> = {
  annotations: "model advisories — excluded while assumed absent; build-side warn trips when not",
};

/** Every other upstream request fact — excluded by doctrine, one entry each. */
export const EXCLUDED_REQUEST_FACTS: Record<
  Exclude<keyof PromptRequestFacts, KeyedRequestFacts>,
  string
> = {
  requester: "who is asking — administrative",
  surface: "gate label — keying re-partitions the cache",
  toolName: "gate label, same doctrine as surface",
  invokedToolName: "gate label (alias re-exposure), same doctrine",
  matchedPattern: "rule name — rendered but instructed noise",
};

/**
 * Build cache material for every fact that affects review semantics.
 *
 * The field set is a `kind`-agnostic decision-relevant superset: every field
 * that could change a verdict across any of the 9 payload kinds, with absent
 * fields (undefined or empty string) normalized to `null` so a missing fact
 * and an empty fact produce the same key.
 *
 * Excluded by design (do not affect the verdict the model can reach):
 * `matchedPattern`, `invokedToolName`, `requester`, `annotations`, `toolName`,
 * and `surface`.
 *
 * `surface` is a gate label, not a decision input: the verdict is driven by
 * the command content, `executedUnit`, and `commandContext` (all in the key),
 * and the SAFETY_RULES instruct the model to treat administrative labels as
 * noise. Two asks that share `kind` + content but differ only in `surface`
 * (e.g. a `bash` kind reached via a shell-alias re-exposure, where `surface`
 * holds the alias name) reach the same verdict and so intentionally collide.
 * The old key's `surface` partition was over-conservative (missed cache hits);
 * dropping it is a correctness gain, not a regression.
 *
 * **Never log this value** — it contains raw, unredacted action text (needed
 * for cache-key distinction). The caller must pass it directly to a hash
 * function.
 *
 * @param request - The review request context (ask + target).
 * @returns A stable serialization for immediate hashing by the caller.
 */
export function reviewRequestCacheMaterial(request: ReviewRequestContext): string {
  const { ask } = request;
  return JSON.stringify({
    kind: ask.kind,
    value: normalizeEmpty(ask.request.value),
    target: normalizeEmpty(request.target),
    fullCommand: normalizeEmpty(ask.fullCommand),
    flaggedElements: ask.flaggedElements.map(normalizeEmpty),
    commandContext: ask.request.commandContext,
    executedUnit: normalizeEmpty(ask.request.executedUnit),
    canonicalBoundary: normalizeEmpty(ask.canonicalBoundary),
    workingDirectory: ask.workingDirectory,
    readPath: normalizeEmpty(ask.readPath),
    resolvedAlias: normalizeEmpty(ask.resolvedAlias),
    toolInputPreview: normalizeEmpty(ask.toolInputPreview),
  });
}
