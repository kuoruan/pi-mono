/**
 * Ask eligibility, review-target resolution, and structured ask projection.
 *
 * Pure functions of (ask details + config) — no session state, no model,
 * no I/O — testable directly through this seam:
 *
 * - `resolveReviewTarget` — does the ask's surface match the configured list, and if so, what value
 *   is being authorized?
 * - `buildAskContext` — project the structured `payload` into a typed `AskContext` that the prompt
 *   renderer and cache key both consume. The one piece of mutable state it touches (the warn-once
 *   annotation-drift flag) is INJECTED — the module stays pure, the caller owns the state.
 * - `openAsk` — the composed seam: one call resolves the target and projects the context, so "the ask
 *   under review" is a single value produced at a single call, not a pair of projections glued by
 *   the caller.
 *
 * The upstream `fact-vocabulary.ts` / `prompt-payload.ts` helpers live in `#src/`
 * internal modules that are NOT re-exported from the package root, so equivalent
 * projections are re-implemented here as private pure functions, mirroring the
 * upstream sources so ai-guard's vocabulary cannot drift from the host's.
 */

import type {
  PromptAnnotation,
  PromptEvidence,
  PromptPayload,
  PromptPayloadKind,
  PromptPermissionDetails,
  PromptRequestFacts,
} from "@gotgenes/pi-permission-system";

import type { AiGuardConfig } from "./config-schema.ts";
import { warn } from "./logger.ts";
import { globMatch } from "./utils.ts";

/**
 * Injected warn-once state for the annotation-drift integrity check:
 * buildAskContext stays pure, and the owner (currently the review
 * pipeline — one instance per session) controls the warn scope.
 */
export interface DriftWarnState {
  /** Whether the drift warning has fired for this state's owner. */
  warned: boolean;
}

/** A resolved review target: the surface and value being authorized. */
export interface ReviewTarget {
  /** Tool surface (e.g. "bash", "mcp", "skill", or a namespaced tool name). */
  surface: string;
  /** The value being authorized (command, tool name, path, etc.). */
  target: string;
}

/** The ask's surface is missing or not in the configured list (silent defer). */
export interface SurfaceUnmatchedReason {
  reason: "surface-unmatched";
}

/** The surface matched but no review target could be extracted (logged defer). */
export interface NoTargetReason {
  reason: "no-target";
  /** The resolved surface, so the caller need not recompute it for logging. */
  surface: string | undefined;
}

/** The surface list a review scans — derived from the config contract, not re-declared. */
export type SurfaceScope = Pick<AiGuardConfig, "surfaces">;

/**
 * The result of {@link resolveReviewTarget}: either the resolved
 * `{ surface, target }`, or a tagged reason the ask did not qualify.
 */
export type ReviewTargetResolution = ReviewTarget | SurfaceUnmatchedReason | NoTargetReason;

/**
 * The structured projection of an ask that the prompt renderer and cache key
 * both consume. `kind`, `request`, and `annotations` are listed flat so each
 * is visible and the renderer reads them directly.
 *
 * Evidence is deliberately absent: it is pre-resolved into the named
 * projection fields below rather than exposed raw. No `ask.*evidence*` access
 * exists; the only exit for evidence is those named fields.
 *
 * Field presence is `kind`-dispatched (see {@link buildAskContext}); fields
 * absent for a given `kind` are `undefined`, and the renderer and cache key
 * treat `undefined` and the empty string uniformly as null.
 */
export interface AskContext {
  /** The renderers' dispatch discriminant. */
  readonly kind: PromptPayloadKind;
  /** The ask's invariant core, reused verbatim from the upstream payload's `request`. */
  readonly request: PromptRequestFacts;
  /** Evidence `full command` text — the complete bash command (bash kinds only). */
  readonly fullCommand?: string;
  /**
   * What the ask flags: for `bash_external_directory`, the escaped external
   * paths; for every other kind, the `value` (or empty when `value` is empty).
   */
  readonly flaggedElements: readonly string[];
  /** Evidence `input` text — the tool-input preview (tool kind). */
  readonly toolInputPreview?: string;
  /** Evidence `read path` text — the path a skill read reached its skill through. */
  readonly readPath?: string;
  /**
   * Evidence `resolves to` text, or an `external path` entry's `detail` — the
   * canonical alias of a flagged path. For `path`/`external_directory` (one
   * path) this is exact. For `bash_external_directory` (possibly many flagged
   * paths) this is the alias of the first external-path entry that carries
   * one, not per-path attribution — a known, bounded limitation (see ADR 0007
   * §5 / CONTEXT.md: `allow` is capped to `defer` on this surface regardless).
   */
  readonly resolvedAlias?: string;
  /** Canonical boundary from `details.accessIntent.boundaryValue` (path surfaces). */
  readonly canonicalBoundary?: string;
  /** The session working directory — the policy containment boundary. */
  readonly workingDirectory: string;
  /** Model-generated advisories (ADR 0011 §8); currently always empty (no annotator registered). */
  readonly annotations: readonly PromptAnnotation[];
}

// ── Evidence projection (re-implemented; upstream helpers are not exported) ──

/**
 * Find the first evidence entry carrying `label`, in payload order.
 *
 * @param payload - The ask's payload.
 * @param label - The evidence label to find.
 * @returns The first matching evidence entry, or `undefined`.
 */
function findEvidence(payload: PromptPayload, label: string): PromptEvidence | undefined {
  return payload.evidence.find((entry) => entry.label === label);
}

/**
 * Every evidence entry carrying `label`, in payload order.
 *
 * @param payload - The ask's payload.
 * @param label - The evidence label to collect.
 * @returns All matching evidence entries in payload order.
 */
function allEvidence(payload: PromptPayload, label: string): readonly PromptEvidence[] {
  return payload.evidence.filter((entry) => entry.label === label);
}

/**
 * What the ask flags (mirrors upstream `flaggedElements`).
 *
 * `bash_external_directory` flags the paths it referenced (the command is the
 * context, the paths are what the operator rules on); every other kind flags
 * the `value`. An empty `value` flags nothing.
 *
 * @param payload - The ask's payload.
 * @returns The flagged values: external paths for `bash_external_directory`, else the `value` (or
 *   empty).
 */
function flaggedElements(payload: PromptPayload): readonly string[] {
  if (payload.kind === "bash_external_directory") {
    return allEvidence(payload, "external path").map((entry) => entry.text);
  }
  return payload.request.value === "" ? [] : [payload.request.value];
}

/**
 * The per-surface flagged fields a payload kind contributes to its
 * AskContext projection.
 */
interface FlaggedFields {
  fullCommand?: string;
  flaggedElements: readonly string[];
  toolInputPreview?: string;
  readPath?: string;
  resolvedAlias?: string;
}

/**
 * The `kind`-dispatched evidence slots for an {@link AskContext}.
 *
 * `fullCommand` falls back to `request.value` when the upstream omits the
 * evidence entry (the full command equals the sub). For
 * `bash_external_directory` the command rides in `request.value` directly, so
 * `fullCommand` is that value and `flaggedElements` are the escaped paths.
 *
 * @param payload - The ask's payload.
 * @returns The `kind`-dispatched evidence slots ({fullCommand, flaggedElements, toolInputPreview,
 *   readPath, resolvedAlias}).
 */
function flaggedFields(payload: PromptPayload): FlaggedFields {
  const flagged = flaggedElements(payload);
  const fullCommandEvidence = findEvidence(payload, "full command")?.text;
  const toolInputPreview = findEvidence(payload, "input")?.text;
  const readPath = findEvidence(payload, "read path")?.text;

  // resolvedAlias: "resolves to" evidence, else the detail of the first
  // external-path entry that carries one (mirrors upstream agent-renderer).
  const resolvesTo = findEvidence(payload, "resolves to")?.text;
  const resolvedAlias: string | undefined =
    resolvesTo ??
    allEvidence(payload, "external path").find((entry) => entry.detail)?.detail ??
    undefined;

  // fullCommand: for bash kinds, the evidence text (or request.value when the
  // full command equals the sub and the upstream omits the entry). For
  // bash_external_directory the command is request.value (no "full command"
  // evidence is emitted); use it directly.
  let fullCommand: string | undefined;
  if (payload.kind === "bash" || payload.kind === "bash_external_directory") {
    fullCommand =
      payload.kind === "bash_external_directory"
        ? payload.request.value || undefined
        : (fullCommandEvidence ?? (payload.request.value || undefined));
  }

  return {
    ...(fullCommand !== undefined ? { fullCommand } : {}),
    flaggedElements: flagged,
    ...(toolInputPreview !== undefined ? { toolInputPreview } : {}),
    ...(readPath !== undefined ? { readPath } : {}),
    ...(resolvedAlias !== undefined ? { resolvedAlias } : {}),
  };
}

/**
 * Extract the display surface, preferring the forwarded intent.
 *
 * @param details - The permission ask details.
 * @returns The surface string, or undefined if none is present.
 */
function surfaceOf(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}

/**
 * Check whether `surface` matches the configured surfaces list.
 * Supports glob-style patterns where `*` matches any character sequence:
 *
 * - `*`: match any surface
 * - `namespace:*`: match all tools under a namespace
 * - `*:bar`: match `bar` under any namespace
 * - `*:*`: match any namespaced surface
 * - Exact surface name (e.g. "bash", "mcp")
 * - "!pattern": exclude (negate) a pattern; exclusions take priority over inclusions. Useful for
 *   surfaces like `external_directory` and `path` that pi-permission-system's bounded-delegation
 *   checkpoint downgrades to `defer` regardless of the verdict. Empty array or excludes-only (no
 *   includes) = review nothing.
 *
 * @param configured - The configured surface patterns (glob, with `!` negation).
 * @param surface - The surface to test.
 * @returns True if `surface` matches an included pattern and is not excluded.
 */
function matchSurface(configured: readonly string[], surface: string): boolean {
  const excludes = configured.filter((e) => e.startsWith("!"));
  if (excludes.some((e) => globMatch(e.slice(1), surface))) {
    return false;
  }
  return configured.some((entry) => !entry.startsWith("!") && globMatch(entry, surface));
}

/**
 * Extract the review target (the value being authorized).
 *
 * Primary source is `payload.request.value`; the `details` display-override
 * fields (still present in v27) are the fail-safe fallback chain for a
 * `forwarded` (degraded) ask whose `value` is empty.
 *
 * `accessIntent.matchValues` (when present, for the path surface) are joined
 * with " | " so the model sees every form — `[absolute, cwd-relative,
 * canonical]` gives both the absolute and symlink-resolved paths, avoiding
 * the symlink-blindness of taking only the first.
 *
 * Note: `external_directory`/`path` allows are capped to `defer` by the host's
 * bounded-delegation checkpoint regardless of target correctness (see
 * CONTEXT.md "Ask eligibility") — the link's value there is limited to a
 * confident `deny`.
 *
 * @param details - The permission ask details.
 * @returns The extracted review target string, or undefined if no field yielded a value.
 */
function extractTarget(details: PromptPermissionDetails): string | undefined {
  const matchValues = details.accessIntent?.matchValues;
  if (matchValues && matchValues.length > 0) {
    return matchValues.join(" | ");
  }

  // payload.request.value is the authoritative decision-relevant value.
  const payloadValue = details.payload.request.value;
  if (payloadValue) {
    return payloadValue;
  }

  // Fail-safe fallback chain for a degraded forwarded ask (empty payload
  // value) or any future shape that leaves value empty: skip empty strings.
  return [
    details.value,
    details.command,
    details.path,
    details.target,
    details.toolName,
    details.skillName,
  ].find((field): field is string => typeof field === "string" && field.length > 0);
}

/**
 * Resolve the review target for an ask.
 *
 * Returns `{ surface, target }` when the ask's surface matches the configured
 * `surfaces` list AND a non-empty target can be extracted. Otherwise returns
 * a tagged reason: `"surface-unmatched"` (surface missing or not configured)
 * is expected config behavior (silent); `"no-target"` (surface matched but
 * no target extractable) is an unexpected ask (logged).
 *
 * Target extraction takes `payload.request.value` as the primary value;
 * the `details` display-override fields (still present in v27 for forwarded
 * / degraded asks) are the fail-safe fallback chain. The `"no-target"`
 * reason stays reachable: a `forwarded` (degraded) ask whose `value` is `""`
 * and whose fallback chain is entirely empty still yields `no-target` rather
 * than a silent review of an empty string.
 *
 * @param details The permission ask details from the Authorizer chain.
 * @param config The surfaces list to match against (glob patterns).
 * @returns The resolved `{ surface, target }` when eligible, or a tagged reason
 *   (`surface-unmatched` / `no-target`, carrying the resolved surface for logging)
 *   when not.
 */
export function resolveReviewTarget(
  details: PromptPermissionDetails,
  config: SurfaceScope,
): ReviewTargetResolution {
  const surface = surfaceOf(details);
  if (!surface) return { reason: "surface-unmatched" };
  if (!matchSurface(config.surfaces, surface)) return { reason: "surface-unmatched" };

  const target = extractTarget(details);
  if (!target) return { reason: "no-target", surface };

  return { surface, target };
}

/**
 * The composed ask-opening result: either the tagged short-circuit reason,
 * or the complete review context (surface + target + projected ask) — the
 * "ask under review" as ONE value produced at ONE call.
 */
export type OpenAskResult =
  | SurfaceUnmatchedReason
  | NoTargetReason
  | (ReviewTarget & { ask: AskContext });

/**
 * Open the ask: resolve the review target and project the structured
 * context in one call. The pipeline's ask-opening shrinks to this seam
 * plus a branch — the eligibility and projection projections stay private
 * steps over a single read of the details.
 *
 * @param details - The permission ask details.
 * @param config - The validated config (surface list).
 * @param cwd - The session working directory.
 * @param driftState - Injected warn-once state, forwarded to the projection.
 * @returns The tagged reason or the complete review context.
 */
export function openAsk(
  details: PromptPermissionDetails,
  config: SurfaceScope,
  cwd: string,
  driftState?: DriftWarnState,
): OpenAskResult {
  const resolved = resolveReviewTarget(details, config);
  if ("reason" in resolved) return resolved;
  return { ...resolved, ask: buildAskContext(details, cwd, driftState) };
}

/**
 * Build the structured {@link AskContext} for an ask.
 *
 * Projects the structured `payload` into named, typed fields by `payload.kind`
 * dispatch (the renderers' discriminant). Evidence is pre-parsed into named
 * slots; the raw `evidence` array is never exposed. `surface` is a display
 * field only.
 *
 * @param details - The permission ask details (the structured `payload` is read directly).
 * @param cwd - The session working directory (policy containment boundary).
 * @param driftState - Injected warn-once state for the annotation-drift check;
 *   absent = the check stays silent (test callers that don't care about the warning).
 * @returns The structured {@link AskContext} with evidence pre-parsed into named fields.
 */
export function buildAskContext(
  details: PromptPermissionDetails,
  cwd: string,
  driftState?: DriftWarnState,
): AskContext {
  const payload = details.payload;
  const boundaryValue = details.accessIntent?.boundaryValue;

  // Invariant: the verdict cache keys WITHOUT annotations (see the
  // exclusion doctrine in review-request.ts), valid only while no
  // annotator is registered upstream. Warn once per injected state when
  // that assumption breaks — silent stale cache hits are the alternative.
  if (payload.annotations.length > 0 && driftState !== undefined && !driftState.warned) {
    driftState.warned = true;
    warn(
      "ask carries model annotations (an upstream annotator is registered) — annotations can change verdicts but are excluded from the verdict-cache key; cache hits may be stale until the key includes them",
    );
  }

  return {
    kind: payload.kind,
    request: payload.request,
    ...flaggedFields(payload),
    canonicalBoundary:
      typeof boundaryValue === "string" && boundaryValue ? boundaryValue : undefined,
    workingDirectory: cwd,
    annotations: payload.annotations,
  };
}
