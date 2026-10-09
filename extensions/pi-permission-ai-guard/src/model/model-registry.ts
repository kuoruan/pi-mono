/**
 * Pi's model registry, projected to the surfaces this extension needs.
 * Lane-neutral: the chat lane reads `find`/`getApiKeyAndHeaders`/
 * `streamSimple`, the classifier lane reads the optional `classify`/
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
 * The chat-lane registry surface: model lookup, auth, and the simple-stream
 * completion.
 *
 * `streamSimple`, not `complete`: the latter routes to the provider's
 * low-level `stream`, which reads `reasoningEffort` and silently drops the
 * simple-layer `reasoning` option — every review would run at the model's
 * `off` level. `streamSimple` translates `reasoning` through the model's
 * `thinkingLevelMap` (pi >= 0.86; the peer floor matches).
 *
 * A `Pick` of the real class instance type so the accepted method set
 * tracks the package's exported shape instead of a hand-written
 * interface that can silently diverge.
 */
export type ChatRegistryLike = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders" | "streamSimple">;

/**
 * The classifier-lane registry surface: pi built-in classifiers
 * (0.99+). Optional throughout — old pi has neither, and
 * registry-classifier endpoints fail fast at registration there
 * (the admission gate in `engines/classifier/endpoints.ts`).
 */
export type RegistryClassifierLike = Partial<Pick<ModelRegistry, "classify" | "findOfType">>;

/** Minimal structural projection of pi's `ModelRegistry` this extension needs. */
export type ModelRegistryLike = ChatRegistryLike & RegistryClassifierLike;
