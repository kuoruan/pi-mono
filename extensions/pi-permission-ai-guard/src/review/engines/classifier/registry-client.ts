/**
 * Registry classifier facade: a `ClassifierClientLike` backed by pi's
 * built-in classifier (`modelRegistry.classify`) instead of the direct
 * TypeSafe SDK. The classifier adapter reaches it through its
 * `registryClient` dep: one facade per `backend: "registry"` endpoint,
 * prebuilt at registration. Registry endpoints never touch the direct
 * `createClient` factory.
 *
 * Wire-shape translation (both directions are explicit here, not hidden
 * in the adapter):
 *
 * - Request: the SDK's `{question, context}` entries flatten to pi-ai's `instructions: string` —
 *   structured context is JSON-serialized and appended, never dropped (the overlay contract is
 *   additive).
 * - `noul` questions become pi-ai `bool` (pi-ai maps back to noul on the wire); choice criteria and
 *   score rubrics pass through unchanged.
 * - Answers: pi-ai's `bool{probability}` projects back to SDK `noul{noul}`; choice maps
 *   field-for-field, while score's `legend`/`probabilities` have no pi-ai counterpart and are
 *   emitted empty — so a registry backend's audit `rawReply` shows those absent where a direct
 *   backend fills them.
 * - Options: SDK `timeout` → `timeoutMs`; SDK `retry.maxRetries` → `maxRetries` (multi-endpoint pools
 *   disable retries — same as direct); SDK `signal` both rides along in the request and bounds the
 *   call with a race — pi-ai ≥0.99 forwards it to the provider, while the race keeps the walk's
 *   remaining budget true on a version that ignores it and skips the request outright once the
 *   budget is spent.
 * - Errors: `classify()` never rejects — a non-`stop` result throws a reconstructed SDK error here
 *   (`APIError` with the parsed status, `APITimeoutError` on timeout/abort wording or an aborted
 *   stop) so the adapter's `instanceof` failure classification works unchanged.
 */

import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
} from "@earendil-works/pi-ai";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";

import type { RegistryClassifierLike } from "#src/model/model-registry.ts";
import type {
  ClassifierQuestions,
  ClassifierClientLike,
  ClassifierSystemOneResponse,
} from "#src/review/engines/classifier/client.ts";
import type { ClassifierQuestionEntry } from "#src/review/engines/classifier/instructions.ts";

/** Pi-ai's `classify` plus model lookup — the facade's registry surface. */
export interface RegistryModelDeps {
  /** Resolved classifier model from `findOfType`. */
  model: ClassifierModel<string>;
  /** Bound `classify` (request-time auth lives inside pi). */
  classify: NonNullable<RegistryClassifierLike["classify"]>;
}

/**
 * Flatten one SDK question entry to pi-ai's string instructions.
 * Structured context serializes to JSON and appends — dropping it would
 * silently change reviewer behavior under an overlay.
 *
 * @param entry - The SDK's text or text+context entry.
 * @returns The flat instructions string.
 */
export function flattenEntry(entry: ClassifierQuestionEntry): string {
  if (typeof entry === "string") return entry;
  return `${entry.question}\n\nStructured context: ${JSON.stringify(entry.context)}`;
}

/**
 * Translate one built classifier request to pi-ai's classifier context.
 * Question types map 1:1 (choice/choice, noul→bool, score/score).
 *
 * @param request - The SDK request from `buildClassifierRequest`.
 * @returns The pi-ai classifier context.
 */
export function toClassifierContext(
  request: SystemOneRequest<ClassifierQuestions>,
): ClassifierContext {
  const danger = request.questions.danger_category;
  const intent = request.questions.intent_match;
  const risk = request.questions.risk;
  const questions: Record<string, ClassifierQuestion> = {
    danger_category: {
      type: "choice",
      instructions: flattenEntry(danger.instructions as ClassifierQuestionEntry),
      criteria: { ...danger.criteria },
    },
    intent_match: {
      type: "bool",
      instructions: flattenEntry(intent.instructions as ClassifierQuestionEntry),
      criteria: {
        true: String(intent.criteria?.true ?? ""),
        false: String(intent.criteria?.false ?? ""),
      },
    },
    risk: {
      type: "score",
      instructions: flattenEntry(risk.instructions as ClassifierQuestionEntry),
      criteria: risk.criteria.map(String),
    },
  };
  // buildClassifierRequest always puts a JsonObject in `state`; the SDK's
  // EntryType is wider, so the narrowing is an assertion pi's type can't see.
  return { state: request.state as ClassifierContext["state"], questions };
}

/**
 * Project pi-ai's answers back to the SDK answer shape the verdict
 * synthesizer consumes. `bool{probability}` becomes `noul{noul}`.
 *
 * @param answers - Pi-ai's answers by question id.
 * @returns The SDK-shaped answers.
 */
export function toSystemOneAnswers(
  answers: Record<string, ClassifierAnswer>,
): ClassifierSystemOneResponse["answers"] {
  const danger = answers.danger_category;
  const intent = answers.intent_match;
  const risk = answers.risk;
  if (danger?.type !== "choice" || intent?.type !== "bool" || risk?.type !== "score") {
    throw new APIConnectionError("incomplete classifier response: missing typed answers");
  }
  return {
    danger_category: {
      type: "choice",
      choice: danger.choice,
      confidence: danger.confidence,
      probabilities: { ...danger.probabilities },
    },
    intent_match: { type: "noul", noul: intent.probability },
    risk: {
      type: "score",
      score: risk.score,
      confidence: risk.confidence,
      legend: {},
      probabilities: {},
    },
  } as ClassifierSystemOneResponse["answers"];
}

const STATUS_PATTERN = /\((\d{3})\)/;

/**
 * Reconstruct an SDK-classified error from a classifier `errorMessage`
 * (`"System One API error (429): <body>"`). A status-bearing failure becomes
 * `APIError` so the adapter's failover table reads the status first — never
 * the wording, or a refusal that mentions a timeout would route around the
 * policy. Status-less timeout/abort wording becomes `APITimeoutError`.
 *
 * @param message - The classifier result's error message.
 * @returns An SDK-shaped error for the adapter's classification.
 */
export function classifierError(message: string): Error {
  const status = STATUS_PATTERN.exec(message)?.[1];
  if (status !== undefined) return APIError.fromResponse(Number(status), message, new Headers());
  if (/timed out|timeout|aborted/i.test(message)) return new APITimeoutError(0);
  return new APIConnectionError(message);
}

/**
 * Await `work`, but throw the walk's timeout the moment `signal` fires. The
 * signal also rides along in the request wherever pi-ai forwards it (≥0.99):
 * this race is what keeps the budget true on a version that ignores it, and it
 * skips the request outright when the budget is already spent. A rejection from
 * the abandoned work is swallowed (the outcome is already decided here).
 *
 * @param work - Deferred classify call; not called at all when the signal already fired.
 * @param signal - The walk-budget signal, when the caller passed one.
 * @returns The classify result, or a throw when the signal fires first.
 */
function raceWithAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new APITimeoutError(0));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new APITimeoutError(0));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (value: T): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const fail = (error: unknown): void => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      // A synchronous throw (context mapping, auth lookup) must not leave the
      // listener behind on a signal that can live for the whole walk.
      fail(error);
      return;
    }
    pending.then(settle, fail);
  });
}

/**
 * Create the registry-backed facade: `systemOne(request, options)` runs
 * the request (built by the adapter from the same state and questions
 * the direct backend sends) through pi's classifier, then projects back
 * to the System One response shape.
 *
 * @param deps - The resolved model plus bound classify fn.
 * @returns A `ClassifierClientLike` over pi's classifier.
 */
export function createRegistryClassifierClient(deps: RegistryModelDeps): ClassifierClientLike {
  return {
    async systemOne(request, options) {
      const result = await raceWithAbort(
        () =>
          deps.classify(deps.model, toClassifierContext(request), {
            timeoutMs: options?.timeout,
            maxRetries: options?.retry?.maxRetries,
            signal: options?.signal,
          }),
        options?.signal,
      );
      if (result.stopReason !== "stop") {
        // An `aborted` stop usually means a timeout — but a status-bearing
        // message wins: a refusal cut short must stay terminal, exactly as
        // {@link classifierError} reads it.
        const failure = result.errorMessage ?? "classifier failed";
        throw result.stopReason === "aborted" && !STATUS_PATTERN.test(failure)
          ? new APITimeoutError(0)
          : classifierError(failure);
      }
      return {
        model: result.model,
        usage: {
          input_tokens: result.usage?.input ?? 0,
          output_tokens: result.usage?.output ?? 0,
        },
        answers: toSystemOneAnswers(result.answers),
      };
    },
  };
}
