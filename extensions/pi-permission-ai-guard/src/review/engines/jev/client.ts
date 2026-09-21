import {
  type ChoiceQuestion,
  type EntryType,
  type JsonValue,
  type NoulQuestion,
  type Questions,
  type RequestOptions,
  type ScoreQuestion,
  type SystemOneRequest,
  type SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

import type { JevQuestionId } from "#src/config/config-schema.ts";
import type { ReviewRequestContext } from "#src/review/request/review-request.ts";
import type { StrippedTranscript } from "#src/review/request/transcript-stripper.ts";
import { normalizeAndRedactText } from "#src/utils.ts";

import { applyOverlay, type JevInstructionsInput, type JevQuestionEntry } from "./instructions.ts";
import { DANGER_CRITERIA, RISK_RUBRIC } from "./questions.ts";

/** Direct TypeSafe connection (both fields optional — unset falls back to env/SDK defaults). */
export interface TypesafeConnection {
  baseUrl?: string;
  apiKey?: string;
}

/**
 * The built-in reviewer role: every question's first background layer.
 * Not user configuration — it tells Jev it is a permission reviewer
 * (the LLM path's system prompt equivalent), so intent/scope read
 * against the authorization anchor rather than free-floating.
 */
export const JEV_REVIEWER_BACKGROUND =
  "You are reviewing one tool call for an AI coding agent. Judge it against the authorization anchor (the latest user request) and the working directory in state.";

/** The built-in questions in the SDK's request shapes. */
export interface JevQuestions extends Questions {
  danger_category: ChoiceQuestion<typeof DANGER_CRITERIA>;
  intent_match: NoulQuestion;
  risk: ScoreQuestion<typeof RISK_RUBRIC>;
}

/** The TypeSafe systemOne response: typed answers plus model and usage metadata. */
export type TypesafeSystemOneResponse = SystemOneResult<JevQuestions>;

/** Minimal SDK surface this module uses (the seam unit tests fake). */
export interface TypesafeClientLike {
  systemOne(
    request: SystemOneRequest<JevQuestions>,
    options?: Pick<RequestOptions, "timeout" | "signal">,
  ): Promise<TypesafeSystemOneResponse>;
}

/**
 * Create the real TypeSafe client. Both fields pass through as-is: `undefined`
 * lets the SDK read TYPESAFE_BASE_URL / TYPESAFE_API_KEY or its built-in URL.
 *
 * @param connection - The resolved baseUrl/apiKey pair (either may be undefined).
 * @returns The SDK-backed client.
 */
export function createTypesafeClient(connection: TypesafeConnection): TypesafeClientLike {
  return new TypeSafeClient({
    apiKey: connection.apiKey,
    baseURL: connection.baseUrl,
  });
}

/**
 * Build the System One state for one ask: the command, its kind, the
 * authorization anchor, and the stripped context — optional keys are
 * added only when present, so no undefined value ever serializes.
 *
 * The untrusted ask fields are redacted here, the LLM prompt's twin: the
 * pipeline hands engines the raw projection (only the transcript arrives
 * sanitized), so a credential in the command would otherwise leave for
 * the TypeSafe service in the clear. The session-supplied working
 * directory is the one exception — passed through (see below).
 *
 * @param request - The review request (ask + resolved target).
 * @param transcript - The stripped transcript.
 * @returns The state entry for the System One request.
 */
function buildState(request: ReviewRequestContext, transcript: StrippedTranscript): EntryType {
  const { ask } = request;
  const state: { [key: string]: JsonValue } = {
    // The action: the bash command when there is one, else the raw value, else
    // the resolved target — a degraded (forwarded) ask whose value is empty is
    // still reviewed on what the ask's fields yielded.
    command: normalizeAndRedactText(ask.fullCommand || ask.request.value || request.target),
    kind: ask.kind,
    authorization_anchor: transcript.trustedIntent.at(-1) ?? "(none found)",
    earlier_context: transcript.trustedIntent.slice(0, -1),
    tool_calls: transcript.toolCalls,
    // cwd comes from the session, not user input — passed unredacted
    // (redaction could mangle paths matching secret prefixes). Note: the
    // LLM prompt still redacts its cwd line (its own doc says otherwise) —
    // that fork is tracked separately, not papered over here.
    working_directory: ask.workingDirectory,
  };
  // Non-bash action carriers (the LLM prompt's tool-input/read-path lines):
  // without these a replace/mcp ask is reviewed blind on intent alone.
  if (ask.toolInputPreview) state.tool_input = normalizeAndRedactText(ask.toolInputPreview);
  if (ask.readPath) state.read_path = normalizeAndRedactText(ask.readPath);
  if (ask.flaggedElements.length > 0) {
    state.flagged_elements = ask.flaggedElements.map(normalizeAndRedactText);
  }
  if (ask.canonicalBoundary) {
    state.canonical_boundary = normalizeAndRedactText(ask.canonicalBoundary);
  }
  if (ask.resolvedAlias) state.resolved_alias = normalizeAndRedactText(ask.resolvedAlias);
  return state;
}

/**
 * Build the System One request for one ask.
 *
 * @param transcript - The stripped transcript.
 * @param request - The review request (ask + resolved target).
 * @param instructions - The background/overlay input.
 * @param model - The Jev model id.
 * @returns The System One request payload.
 */
export function buildJevRequest(
  transcript: StrippedTranscript,
  request: ReviewRequestContext,
  instructions: JevInstructionsInput,
  model: string,
): SystemOneRequest<JevQuestions> {
  // Three layers, applied in order: the built-in reviewer role, the
  // user's shared background, then the question's own override (each
  // layer adds rather than replacing).
  const overlay =
    typeof instructions === "string" ? { background: instructions } : (instructions ?? {});
  const perQuestion = overlay.questions ?? {};
  const bg = overlay.background;

  const q = (id: JevQuestionId, base: string): JevQuestionEntry => {
    // The built-in role always leads: the user's background appends after it.
    const withRole = applyOverlay(base, JEV_REVIEWER_BACKGROUND);
    const withBg = bg === undefined ? withRole : applyOverlay(withRole, bg);
    const extra = perQuestion[id];
    return extra === undefined ? withBg : applyOverlay(withBg, extra);
  };

  return {
    model,
    state: buildState(request, transcript),
    questions: {
      danger_category: {
        type: "choice",
        instructions: q(
          "danger_category",
          "Which always-deny category does this action match, if any?",
        ),
        criteria: DANGER_CRITERIA,
      },
      intent_match: {
        type: "noul",
        instructions: q("intent_match", "The authorization anchor authorizes this action."),
      },
      risk: {
        type: "score",
        instructions: q("risk", "Rate the overall risk of this action."),
        criteria: [...RISK_RUBRIC],
      },
    },
  };
}
