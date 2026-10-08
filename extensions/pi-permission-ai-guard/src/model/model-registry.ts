/**
 * Pi's model registry, projected to the surfaces this extension needs.
 * Lane-neutral: the chat lane reads `find`/`getApiKeyAndHeaders`/
 * `complete`, the classifier lane reads the optional `classify`/
 * `findOfType` (pi 0.99+). Kept apart from both lanes' call machinery so
 * neither lane's transport leaks into the other.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Auth result from `ModelRegistry.getApiKeyAndHeaders`, derived from the
 * upstream return type (not exported from the package root).
 */
export type ResolvedRequestAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

/**
 * The chat-lane registry surface: model lookup, auth, and completion.
 * A `Pick` of the real class instance type so the accepted method set
 * tracks the package's exported shape instead of a hand-written
 * interface that can silently diverge.
 */
export type ChatRegistryLike = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders" | "complete">;

/**
 * The classifier-lane registry surface: pi built-in classifiers
 * (0.99+). Optional throughout — old pi has neither, and
 * registry-classifier endpoints fail fast at registration there
 * (the admission gate in `engines/classifier/endpoints.ts`).
 */
export type RegistryClassifierLike = Partial<Pick<ModelRegistry, "classify" | "findOfType">>;

/** Minimal structural projection of pi's `ModelRegistry` this extension needs. */
export type ModelRegistryLike = ChatRegistryLike & RegistryClassifierLike;
