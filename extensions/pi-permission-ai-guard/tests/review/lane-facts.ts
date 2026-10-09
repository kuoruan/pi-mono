/**
 * Cross-lane ask-fact inventory: one classification per ask fact, per lane.
 * The `LANE_*_FACTS` records are exhaustive, so a new `AskContext` /
 * `PromptRequestFacts` field stops compilation until both lanes classify it.
 *
 * Test-side on purpose — no lane imports it (the renderers stay hand-written,
 * not table-driven), and `tsc` type-checks `tests/` alongside `src/`, so the
 * tripwire holds. It pins presence, not presentation: the two intentional
 * encoding forks are `workingDirectory` (chat redacts, classifier verbatim)
 * and `commandContext` (chat words, classifier raw). The verdict cache keeps
 * its own raw-value doctrine in `review-request.ts`.
 */

import type { PromptRequestFacts } from "@gotgenes/pi-permission-system";

import type { AskContext } from "#src/review/request/ask.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";

/** How one lane exposes a fact, or why it does not. */
export type LaneSlot =
  | {
      readonly rendered: true;
      /** The chat line label (without its `- ` and `:`) or classifier state key. */
      readonly name: string;
      /** The encoder the lane applies. */
      readonly encode: "action" | "words" | "redact" | "raw" | "verbatim";
    }
  | { readonly rendered: false; readonly reason: string };

/** One ask fact as each lane treats it. */
export interface LaneFact {
  readonly chat: LaneSlot;
  readonly classifier: LaneSlot;
}

/** `AskContext` minus `request` (which decomposes into {@link LANE_REQUEST_FACTS}). */
export const LANE_ASK_FACTS: Record<Exclude<keyof AskContext, "request">, LaneFact> = {
  kind: {
    chat: { rendered: false, reason: "dispatch discriminant — selects the action line" },
    classifier: { rendered: true, name: "kind", encode: "raw" },
  },
  fullCommand: {
    chat: { rendered: true, name: "command", encode: "action" },
    classifier: { rendered: true, name: "command", encode: "redact" },
  },
  flaggedElements: {
    chat: { rendered: true, name: "external path(s)", encode: "action" },
    classifier: { rendered: true, name: "flagged_elements", encode: "redact" },
  },
  toolInputPreview: {
    chat: { rendered: true, name: "tool input", encode: "action" },
    classifier: { rendered: true, name: "tool_input", encode: "redact" },
  },
  readPath: {
    chat: { rendered: true, name: "read path", encode: "redact" },
    classifier: { rendered: true, name: "read_path", encode: "redact" },
  },
  resolvedAlias: {
    chat: { rendered: true, name: "resolved alias", encode: "redact" },
    classifier: { rendered: true, name: "resolved_alias", encode: "redact" },
  },
  canonicalBoundary: {
    chat: { rendered: true, name: "canonical boundary", encode: "redact" },
    classifier: { rendered: true, name: "canonical_boundary", encode: "redact" },
  },
  workingDirectory: {
    chat: { rendered: true, name: "working directory", encode: "action" },
    classifier: { rendered: true, name: "working_directory", encode: "verbatim" },
  },
  annotations: {
    chat: { rendered: false, reason: "model-generated advisories — deliberately not rendered" },
    classifier: { rendered: false, reason: "model-generated advisories — not carried" },
  },
};

/**
 * The upstream `PromptRequestFacts`. Administrative and gate-label facts are
 * excluded by both lanes; the wrapper facts are carried by both. `value` folds
 * into the action line/key with `fullCommand` and the context `target` (bash
 * renders `- command:`, non-bash `- target:`; the classifier renders one
 * `command` key).
 */
export const LANE_REQUEST_FACTS: Record<keyof PromptRequestFacts, LaneFact> = {
  requester: {
    chat: { rendered: false, reason: "who is asking — administrative" },
    classifier: { rendered: false, reason: "who is asking — administrative" },
  },
  surface: {
    chat: { rendered: false, reason: "gate label — not a decision input" },
    classifier: { rendered: false, reason: "gate label — not a decision input" },
  },
  toolName: {
    chat: { rendered: false, reason: "gate label — not a decision input" },
    classifier: { rendered: false, reason: "gate label — not a decision input" },
  },
  invokedToolName: {
    chat: { rendered: false, reason: "gate label (alias re-exposure)" },
    classifier: { rendered: false, reason: "gate label (alias re-exposure)" },
  },
  value: {
    chat: { rendered: true, name: "command (bash) / target (non-bash)", encode: "action" },
    classifier: { rendered: true, name: "command", encode: "redact" },
  },
  matchedPattern: {
    chat: { rendered: true, name: "matched rule", encode: "redact" },
    classifier: { rendered: true, name: "matched_pattern", encode: "redact" },
  },
  commandContext: {
    chat: { rendered: true, name: "command context", encode: "words" },
    classifier: { rendered: true, name: "command_context", encode: "raw" },
  },
  executedUnit: {
    chat: { rendered: true, name: "executed unit", encode: "action" },
    classifier: { rendered: true, name: "executed_unit", encode: "redact" },
  },
};

/** `ReviewRequestContext` outside the ask; `target` folds into the action line/key. */
export const LANE_CONTEXT_FACTS: Record<Exclude<keyof ReviewRequestContext, "ask">, LaneFact> = {
  target: {
    chat: { rendered: true, name: "target", encode: "redact" },
    classifier: { rendered: true, name: "command", encode: "redact" },
  },
};
