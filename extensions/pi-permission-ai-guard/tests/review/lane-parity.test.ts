/**
 * Cross-lane ask-fact parity: `lane-facts.ts` is the inventory; this suite
 * pins that both lanes honor it. Expectations are literal strings, not the
 * lane's own encoder re-run, so a shared encoder bug cannot pass tautologically.
 */

import type { PromptRequestFacts } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "#src/review/engines/chat/prompt.ts";
import { buildClassifierRequest } from "#src/review/engines/classifier/client.ts";
import type { ClassifierOverlay } from "#src/review/engines/classifier/instructions.ts";
import type { AskContext } from "#src/review/request/ask.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";
import {
  LANE_ASK_FACTS,
  LANE_CONTEXT_FACTS,
  LANE_REQUEST_FACTS,
  type LaneFact,
} from "#test/review/lane-facts.ts";

/** Every fact in the inventory, flattened to one key space. */
type InventoryFactKey =
  | keyof typeof LANE_ASK_FACTS
  | keyof typeof LANE_REQUEST_FACTS
  | keyof typeof LANE_CONTEXT_FACTS;

const INVENTORY: Record<InventoryFactKey, LaneFact> = {
  ...LANE_ASK_FACTS,
  ...LANE_REQUEST_FACTS,
  ...LANE_CONTEXT_FACTS,
};

const NO_INSTRUCTIONS: ClassifierOverlay = {};

function transcript(): StrippedTranscript {
  return { trustedIntent: ["clean up temp files"], toolCalls: [], strippedCount: 0 };
}

/**
 * Sentinel source values. Each is chosen to survive `normalizeAndRedactText`
 * verbatim (no whitespace runs, no secret-shaped text), so a lane that
 * renders it can be checked by substring and a lane that excludes it can be
 * checked by its absence.
 */
const S = {
  value: "SENTINEL-value",
  fullCommand: "SENTINEL-full-command",
  target: "SENTINEL-target",
  executedUnit: "SENTINEL-executed-unit",
  matchedPattern: "SENTINEL-matched-pattern",
  matchedSpelling: "SENTINEL-matched-spelling",
  commandContext: "command_substitution",
  toolInputPreview: "SENTINEL-tool-input",
  readPath: "SENTINEL-read-path",
  resolvedAlias: "SENTINEL-resolved-alias",
  canonicalBoundary: "SENTINEL-canonical-boundary",
  workingDirectory: "SENTINEL-working-directory",
  flagged: "SENTINEL-flagged",
  kind: "bash_external_directory",
  requester: "SENTINEL-requester",
  surface: "SENTINEL-surface",
  toolName: "SENTINEL-tool-name",
  invokedToolName: "SENTINEL-invoked-tool",
  annotation: "SENTINEL-annotation",
} as const;

function baseContext(): ReviewRequestContext {
  return {
    ask: {
      kind: "bash",
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "bash",
        toolName: null,
        invokedToolName: null,
        value: "",
        matchedPattern: null,
        matchedSpelling: null,
        commandContext: null,
        executedUnit: null,
      },
      flaggedElements: [],
      workingDirectory: "/project",
      annotations: [],
    },
    target: "",
  };
}

function ctx(overrides: {
  ask?: Partial<AskContext>;
  request?: Partial<PromptRequestFacts>;
  target?: string;
}): ReviewRequestContext {
  const base = baseContext();
  return {
    ask: { ...base.ask, ...overrides.ask, request: { ...base.ask.request, ...overrides.request } },
    target: overrides.target ?? base.target,
  };
}

interface FactCase {
  readonly context: ReviewRequestContext;
  /** The source value; asserted absent from a lane that excludes the fact. */
  readonly sentinel: string;
  /** Expected substring of the chat prompt, or null when the lane excludes it. */
  readonly chat: string | null;
  /** Expected substring of the classifier state JSON, or null when excluded. */
  readonly classifier: string | null;
}

/**
 * One fixture per fact, built so the fact is the only observable value the
 * lane could be rendering (the merged action facts — `value` /
 * `fullCommand` / `target` — each get a fixture where they are the one that
 * wins the fold).
 */
const CASES: Record<InventoryFactKey, FactCase> = {
  kind: {
    context: ctx({ ask: { kind: S.kind } }),
    sentinel: S.kind,
    chat: null,
    classifier: S.kind,
  },
  fullCommand: {
    context: ctx({
      ask: { kind: "bash", fullCommand: S.fullCommand },
      request: { value: S.value },
    }),
    sentinel: S.fullCommand,
    chat: S.fullCommand,
    classifier: S.fullCommand,
  },
  flaggedElements: {
    context: ctx({
      ask: { kind: "bash_external_directory", flaggedElements: [S.flagged] },
      request: { value: S.value },
    }),
    sentinel: S.flagged,
    chat: S.flagged,
    classifier: S.flagged,
  },
  toolInputPreview: {
    context: ctx({ ask: { toolInputPreview: S.toolInputPreview } }),
    sentinel: S.toolInputPreview,
    chat: S.toolInputPreview,
    classifier: S.toolInputPreview,
  },
  readPath: {
    context: ctx({ ask: { readPath: S.readPath } }),
    sentinel: S.readPath,
    chat: S.readPath,
    classifier: S.readPath,
  },
  resolvedAlias: {
    context: ctx({ ask: { resolvedAlias: S.resolvedAlias } }),
    sentinel: S.resolvedAlias,
    chat: S.resolvedAlias,
    classifier: S.resolvedAlias,
  },
  canonicalBoundary: {
    context: ctx({ ask: { canonicalBoundary: S.canonicalBoundary } }),
    sentinel: S.canonicalBoundary,
    chat: S.canonicalBoundary,
    classifier: S.canonicalBoundary,
  },
  workingDirectory: {
    context: ctx({ ask: { workingDirectory: S.workingDirectory } }),
    sentinel: S.workingDirectory,
    chat: S.workingDirectory,
    classifier: S.workingDirectory,
  },
  annotations: {
    context: ctx({ ask: { annotations: [{ source: "SENTINEL-source", text: S.annotation }] } }),
    sentinel: S.annotation,
    chat: null,
    classifier: null,
  },
  requester: {
    context: ctx({
      request: { requester: { agentName: S.requester, forwarded: false, sessionId: null } },
    }),
    sentinel: S.requester,
    chat: null,
    classifier: null,
  },
  surface: {
    context: ctx({ request: { surface: S.surface } }),
    sentinel: S.surface,
    chat: null,
    classifier: null,
  },
  toolName: {
    context: ctx({ request: { toolName: S.toolName } }),
    sentinel: S.toolName,
    chat: null,
    classifier: null,
  },
  invokedToolName: {
    context: ctx({ request: { invokedToolName: S.invokedToolName } }),
    sentinel: S.invokedToolName,
    chat: null,
    classifier: null,
  },
  value: {
    context: ctx({ ask: { kind: "bash" }, request: { value: S.value } }),
    sentinel: S.value,
    chat: S.value,
    classifier: S.value,
  },
  matchedPattern: {
    context: ctx({ request: { matchedPattern: S.matchedPattern } }),
    sentinel: S.matchedPattern,
    chat: S.matchedPattern,
    classifier: S.matchedPattern,
  },
  matchedSpelling: {
    context: ctx({ request: { matchedSpelling: S.matchedSpelling } }),
    sentinel: S.matchedSpelling,
    chat: S.matchedSpelling,
    classifier: S.matchedSpelling,
  },
  // The words/raw fork: chat renders prose, the classifier keeps the fact id.
  commandContext: {
    context: ctx({ request: { commandContext: S.commandContext } }),
    sentinel: S.commandContext,
    chat: "command substitution",
    classifier: S.commandContext,
  },
  executedUnit: {
    context: ctx({ request: { executedUnit: S.executedUnit } }),
    sentinel: S.executedUnit,
    chat: S.executedUnit,
    classifier: S.executedUnit,
  },
  target: {
    context: ctx({ ask: { kind: "tool" }, request: { value: "" }, target: S.target }),
    sentinel: S.target,
    chat: S.target,
    classifier: S.target,
  },
};

describe("lane-fact inventory parity", () => {
  for (const key of Object.keys(INVENTORY) as InventoryFactKey[]) {
    it(`${key}: each lane honors the inventory`, () => {
      const { context, sentinel, chat, classifier } = CASES[key];
      const fact = INVENTORY[key];
      const chatOutput = buildReviewPrompt(transcript(), context);
      const stateJson = JSON.stringify(
        buildClassifierRequest(transcript(), context, NO_INSTRUCTIONS, "model").state,
      );

      expect(fact.chat.rendered).toBe(chat !== null);
      expect(fact.classifier.rendered).toBe(classifier !== null);

      const chatOk = chat === null ? !chatOutput.includes(sentinel) : chatOutput.includes(chat);
      const classifierOk =
        classifier === null ? !stateJson.includes(sentinel) : stateJson.includes(classifier);
      expect(chatOk, `${key}: chat should ${chat === null ? "omit" : "contain"} the fact`).toBe(
        true,
      );
      expect(
        classifierOk,
        `${key}: classifier should ${classifier === null ? "omit" : "contain"} the fact`,
      ).toBe(true);
    });
  }
});

describe("classifier wrapper-fact keys", () => {
  it("carries the wrapper facts under their documented state keys", () => {
    const requestContext = ctx({
      request: {
        executedUnit: S.executedUnit,
        matchedPattern: S.matchedPattern,
        commandContext: S.commandContext,
      },
    });
    const state = buildClassifierRequest(transcript(), requestContext, NO_INSTRUCTIONS, "model")
      .state as Record<string, unknown>;

    expect(state.executed_unit).toBe(S.executedUnit);
    expect(state.matched_pattern).toBe(S.matchedPattern);
    expect(state.command_context).toBe(S.commandContext);
  });

  it("omits the wrapper keys when the ask has no wrapper facts", () => {
    const state = buildClassifierRequest(transcript(), ctx({}), NO_INSTRUCTIONS, "model")
      .state as Record<string, unknown>;

    expect(state).not.toHaveProperty("executed_unit");
    expect(state).not.toHaveProperty("matched_pattern");
    expect(state).not.toHaveProperty("command_context");
  });
});

describe("classifier spelling-fact key", () => {
  it("carries the matched spelling under its documented state key", () => {
    const state = buildClassifierRequest(
      transcript(),
      ctx({ request: { matchedSpelling: S.matchedSpelling } }),
      NO_INSTRUCTIONS,
      "model",
    ).state as Record<string, unknown>;

    expect(state.matched_spelling).toBe(S.matchedSpelling);
  });

  it("omits the key when the typed text decided", () => {
    const state = buildClassifierRequest(transcript(), ctx({}), NO_INSTRUCTIONS, "model")
      .state as Record<string, unknown>;

    expect(state).not.toHaveProperty("matched_spelling");
  });
});
