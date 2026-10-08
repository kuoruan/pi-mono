/**
 * Classifier lane endpoint construction. Owns every lane-shape fact the
 * assembler used to re-derive: which provider shapes and `modelType`
 * values address this lane, which registry backends must resolve before
 * registration, and how the two backends (direct SDK vs pi's built-in
 * classifier) prebuild their clients.
 *
 * Nothing downstream of this module branches on lane or backend shape —
 * the pool walks endpoints, the adapter attempts them.
 */

import type { ClassifierModel } from "@earendil-works/pi-ai";

import type { ConfigIssue } from "#src/config/config-layer.ts";
import type { ModelRegistryLike } from "#src/model/model-registry.ts";
import type { ClassifierPoolEndpoint, ClassifierProvider } from "#src/review/pool.ts";

import { type ClassifierClientLike, createDirectClient } from "./client.ts";
import { createRegistryClassifierClient } from "./registry-client.ts";

/** Addressing fields shared by primary and fallback config entries. */
interface ClassifierTarget {
  /** Explicit connection (direct backend) or registry provider id. */
  provider: string | ClassifierProvider;
  model: string;
  timeoutMs: number;
}

/** Probe for a registry classifier model; false = absent from pi's catalog. */
type ClassifierProbe = (provider: string, model: string) => boolean;

/** Pi's catalog lookup, with the registry's `this` bound. */
type ClassifierLookup = (
  type: "classifier",
  provider: string,
  model: string,
) => ClassifierModel<string> | undefined;

/** What a lane must know to admit one configured endpoint into the pool. */
export interface ClassifierAdmission {
  /** Catalog probe; absent means the registry cannot answer (old pi). */
  probe?: ClassifierProbe;
  /** Sink for degraded (non-primary) rejections. */
  onSkipped?: (issue: ConfigIssue) => void;
}

/**
 * Resolve one configured classifier entry into pool endpoints.
 *
 * A direct connection is always admitted. A registry backend must first
 * clear the structural gate: pi must expose `classify` + `findOfType`
 * (0.99+) and the model must exist in pi's catalog. An unresolvable
 * *primary* throws — a broken primary means no reviewer at all
 * (fail-safe session start). An unresolvable *fallback* is reported and
 * dropped — the fallback contract is "a broken backup degrades", and a
 * dropped endpoint must never reach `attempt()`.
 *
 * @param target - Addressing fields plus the entry's resolved timeout.
 * @param position - Config position (0 = primary); decides throw vs skip.
 * @param admission - Probe and skip sink.
 * @returns The admitted endpoints (empty when a fallback degraded away).
 */
export function resolveClassifierEntry(
  target: ClassifierTarget,
  position: number,
  admission?: ClassifierAdmission,
): ClassifierPoolEndpoint[] {
  const endpoint: ClassifierPoolEndpoint =
    typeof target.provider === "object"
      ? {
          lane: "classifier",
          backend: "direct",
          provider: target.provider,
          model: target.model,
          timeoutMs: target.timeoutMs,
        }
      : {
          lane: "classifier",
          backend: "registry",
          provider: target.provider,
          model: target.model,
          timeoutMs: target.timeoutMs,
        };
  if (endpoint.backend !== "registry") return [endpoint];
  // No admission means the caller wants pure routing (every endpoint
  // admitted as written) — the structural gate is opt-in.
  if (!admission) return [endpoint];
  const id = `${endpoint.provider}/${endpoint.model}`;
  if (!admission.probe) {
    return reject(
      position,
      admission.onSkipped,
      `registry classifier fallback needs pi with classifier support — skipped`,
      `registry classifier primary (${id}) needs pi with classifier support — upgrade pi or use a direct System One provider`,
      "",
    );
  }
  if (!admission.probe(endpoint.provider, endpoint.model)) {
    return reject(
      position,
      admission.onSkipped,
      `registry classifier model ${id} not found in pi's model catalog — skipped`,
      `registry classifier primary (${id}) not found in pi's model catalog — check the provider id and model`,
      ".model",
    );
  }
  return [endpoint];
}

/**
 * Resolve every registry classifier endpoint's model eagerly and cache
 * the facade, keyed by provider/model. Per-ask resolution would let a
 * catalog hot-change turn an admitted endpoint into a throw inside
 * `attempt()`; resolving here keeps ask-time failures to the transport.
 *
 * @param endpoints - The admitted endpoint list.
 * @param registry - The model registry from the session.
 * @returns The facade per registry backend endpoint.
 */
export function prebuildRegistryClients(
  endpoints: readonly ClassifierPoolEndpoint[],
  registry: ModelRegistryLike,
): Map<string, ClassifierClientLike> {
  const clients = new Map<string, ClassifierClientLike>();
  if (typeof registry.classify !== "function") return clients;
  const lookup = classifierLookup(registry);
  if (!lookup) return clients;
  // Bind: `classify` reads `this.runtime` on pi's registry, so a detached
  // reference throws `TypeError` at call time.
  const classify = registry.classify.bind(registry);
  for (const endpoint of registryEndpoints(endpoints)) {
    const model = lookup("classifier", endpoint.provider, endpoint.model);
    // Admission already proved this model resolves; a miss here means
    // the catalog changed between probe and prebuild — the endpoint then
    // has no client and the adapter's "not prebuilt" guard fires rather
    // than a stale facade going out to the model.
    if (!model) continue;
    clients.set(
      registryKey(endpoint.provider, endpoint.model),
      createRegistryClassifierClient({ model, classify }),
    );
  }
  return clients;
}

/**
 * Fetch the prebuilt facade for a registry endpoint — the adapter's only
 * access path. Admission already proved this model resolved, so a miss
 * here is a wiring bug, not an availability signal.
 *
 * @param clients - The prebuilt facade map.
 * @param provider - The registry provider id.
 * @param model - The classifier model id.
 * @returns The facade client.
 */
export function registryClientFor(
  clients: ReadonlyMap<string, ClassifierClientLike>,
  provider: string,
  model: string,
): ClassifierClientLike {
  const client = clients.get(registryKey(provider, model));
  if (!client) throw new Error("unreachable: registry classifier client not prebuilt");
  return client;
}

/**
 * Prebuild direct SDK clients keyed by provider identity (baseUrl +
 * apiKey), so an unresolvable key/baseUrl fails fast at registration and
 * shared credentials share one client.
 *
 * @param endpoints - The admitted endpoint list.
 * @param createClient - The SDK constructor (tests inject fakes).
 * @returns The client per direct connection identity.
 */
export function prebuildDirectClients(
  endpoints: readonly ClassifierPoolEndpoint[],
  createClient: (provider: ClassifierProvider) => ClassifierClientLike = createDirectClient,
): Map<string, ClassifierClientLike> {
  const clients = new Map<string, ClassifierClientLike>();
  for (const endpoint of endpoints) {
    if (endpoint.backend !== "direct") continue;
    const key = directKey(endpoint.provider);
    if (!clients.has(key)) clients.set(key, createClient(endpoint.provider));
  }
  return clients;
}

/**
 * Fetch a prebuilt direct client — a wiring bug if absent.
 *
 * @param clients - The prebuilt client map.
 * @param provider - The direct provider connection.
 * @returns The SDK client.
 */
export function directClientFor(
  clients: ReadonlyMap<string, ClassifierClientLike>,
  provider: ClassifierProvider,
): ClassifierClientLike {
  const client = clients.get(directKey(provider));
  if (!client) throw new Error("unreachable: classifier client not prebuilt");
  return client;
}

/**
 * Build the catalog probe, or undefined when pi cannot answer — the
 * admission then degrades fallbacks and throws on a primary.
 *
 * @param registry - The model registry from the session.
 * @returns The probe, or undefined on a registry without classifier support.
 */
export function classifierProbe(registry: ModelRegistryLike): ClassifierProbe | undefined {
  const lookup = classifierLookup(registry);
  // pi exposes `classify` + `findOfType` together (0.99+); neither is
  // callable on older pi, which is what makes the whole lane optional.
  if (!lookup || typeof registry.classify !== "function") return undefined;
  return (provider, model) => lookup("classifier", provider, model) !== undefined;
}

/**
 * Throw for a primary, report-and-drop for a fallback.
 *
 * @param position - Endpoint position: 0 is the primary.
 * @param onSkipped - Sink for the dropped-fallback issue.
 * @param fallbackMessage - Message when a fallback is dropped.
 * @param primaryMessage - The error thrown for a broken primary.
 * @param field - Suffix naming the offending field (a catalog miss is the model's).
 * @returns Always empty — a rejected entry contributes no endpoint.
 */
function reject(
  position: number,
  onSkipped: ((issue: ConfigIssue) => void) | undefined,
  fallbackMessage: string,
  primaryMessage: string,
  /** Suffix naming the offending field (a catalog miss is the model's). */
  field: string,
): ClassifierPoolEndpoint[] {
  if (position === 0) throw new Error(primaryMessage);
  onSkipped?.({ path: `fallbacks.${position - 1}${field}`, message: fallbackMessage });
  return [];
}

/**
 * The registry-backend endpoints, narrowed.
 *
 * @param endpoints - Classifier endpoints of either backend.
 * @returns The registry-backed subset, with `provider`/`model` narrowed.
 */
function registryEndpoints(
  endpoints: readonly ClassifierPoolEndpoint[],
): readonly { provider: string; model: string }[] {
  return endpoints.filter((e) => e.backend === "registry");
}

/**
 * Bind pi's catalog lookup for classifier models, or undefined when the
 * registry has none. Bound because the method reads `this.runtime` on pi's
 * registry: a detached reference throws at call time.
 *
 * @param registry - The model registry from the session.
 * @returns The bound lookup, or undefined on a registry without `findOfType`.
 */
function classifierLookup(registry: ModelRegistryLike): ClassifierLookup | undefined {
  const findOfType = registry.findOfType;
  return typeof findOfType === "function" ? findOfType.bind(registry) : undefined;
}

/**
 * Cache key for one registry model.
 *
 * @param provider - Registry provider id.
 * @param model - Registry model id.
 * @returns The cache key.
 */
function registryKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

/**
 * Cache key for one direct connection identity. Shared by the prebuilt
 * client map and the adapter's own memo, so both agree on when two
 * endpoints may share a client.
 *
 * @param provider - The direct connection (URL + key).
 * @returns The cache key.
 */
export function directKey(provider: ClassifierProvider): string {
  return `${provider.baseUrl ?? ""}\0${provider.apiKey ?? ""}`;
}
