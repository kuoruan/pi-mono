/**
 * Shared doubles for the classifier-lane suites. The registry facade and the
 * pi-ai shapes it consumes live here because the `classify` cast is easy to
 * get subtly wrong and a pi-ai result-shape change should break one file, not
 * every test that fabricates a reply.
 */

import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

import type { ModelRegistryLike, RegistryClassifierLike } from "#src/model/model-registry.ts";
import type { ClassifierClientLike } from "#src/review/engines/classifier/client.ts";
import { createRegistryClassifierClient } from "#src/review/engines/classifier/registry-client.ts";

/** The model id the registry doubles declare (the facade passes it through). */
export const REGISTRY_MODEL_ID = "jev-latest";

/** The classifier api the registry doubles declare. */
export const REGISTRY_API: ClassifierApi = "typesafe-system-one";

/** Pi's `classify`, as the facade receives it — the type a stub must satisfy. */
export type RegistryClassify = NonNullable<RegistryClassifierLike["classify"]>;

/**
 * A real (if minimal) catalog entry, for pi's `findOfType`. Spelling the
 * catalogue fields out keeps the double assignable to `ClassifierModel`
 * without a cast, so a new required field breaks here instead of silently
 * narrowing what the registry tests cover.
 */
export const fakeClassifierModel: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  id: REGISTRY_MODEL_ID,
  name: REGISTRY_MODEL_ID,
  api: REGISTRY_API,
  provider: "typesafe",
  baseUrl: "https://api.typesafe.ai",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
};

/**
 * A pi-ai classifier reply that answered all three questions.
 *
 * @param overrides - Reply fields to replace.
 * @returns The reply, in pi-ai's full result shape.
 */
export function classifierReply(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
  return {
    api: REGISTRY_API,
    provider: "typesafe",
    model: REGISTRY_MODEL_ID,
    timestamp: 0,
    stopReason: "stop",
    answers: {
      danger_category: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
      intent_match: { type: "bool", probability: 0.8 },
      risk: { type: "score", score: 1, confidence: 0.7 },
    },
    usage: {
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

/**
 * A pi-ai classifier reply that failed: `stopReason: "error"` plus the message
 * the facade rebuilds an SDK error from.
 *
 * @param errorMessage - The classifier's failure text.
 * @returns The failed reply.
 */
export function errorClassifierReply(errorMessage: string): ClassifierResult {
  return classifierReply({ stopReason: "error", answers: {}, errorMessage });
}

/**
 * A `findOfType` stub for the classifier lane. pi's method is generic over the
 * model type, so a concrete classifier model needs an assertion; it is
 * confined here and every call site stays a plain boolean.
 *
 * @param present - Whether the catalog reports the entry.
 * @returns The `findOfType` override.
 */
export function findClassifierOfType(present = true): ModelRegistryLike["findOfType"] {
  return (() =>
    present ? fakeClassifierModel : undefined) as unknown as ModelRegistryLike["findOfType"];
}

/**
 * A registry facade over a fake `classify`. No cast: the stub is typed as the
 * real `classify` signature and returns a real `ClassifierResult`.
 *
 * @param classify - The fake `classify` implementation.
 * @returns The facade a `backend: "registry"` endpoint attempts through.
 */
export function registryFacade(classify: RegistryClassify): ClassifierClientLike {
  return createRegistryClassifierClient({ model: fakeClassifierModel, classify });
}
