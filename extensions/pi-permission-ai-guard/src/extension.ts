/**
 * Extension wiring: load config at session_start, register the
 * "ai-guard" chain link, and dispose on shutdown.
 *
 * Registration is attempted from both session_start and permissions:ready
 * behind an idempotency guard (`registered`), because the relative order of
 * the two events is not guaranteed: permissions:ready may fire before or
 * after the session_start handler runs. The guard prevents a double
 * registration within one module instance.
 *
 * /reload reloads the extension module (resetting `registered`), but the
 * reload sequence emits session_shutdown to the old instance first (which
 * disposes the old registration), so the new instance registers cleanly.
 * If a stale registration nonetheless remains (e.g. the dispose didn't
 * take effect), registerAuthorizer throws "already registered" — caught
 * and warned, not fatal.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Authorizer,
  getPermissionsService,
  PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";

import { type LoadConfigResult, loadAiGuardConfig } from "./config-loader.ts";
import { LINK_NAME } from "./config-schema.ts";
import { debug, warn } from "./logger.ts";
import {
  type CompleteSimpleFn,
  type ModelRegistryLike,
  createCompleteSimple,
} from "./model-review.ts";
import { type ReviewPipelineDeps, createReviewPipeline } from "./review-pipeline.ts";
import { CircuitBreaker, VerdictCache } from "./session-state.ts";
import type { SessionManagerLike } from "./transcript-stripper.ts";

/**
 * Per-session state. Created at session_start, cleared at session_shutdown.
 * KEPT across permissions:ready re-registration (the session itself hasn't
 * changed — only the authorizer link is re-registered).
 */
interface SessionState {
  /** Validated extension config, or undefined if loading failed (fail-safe). */
  config: LoadConfigResult["config"];
  /** Model registry from the session context — resolves the reviewer model. */
  registry: ModelRegistryLike;
  /** Session manager for transcript stripping (trusted intent + tool calls). */
  sessionManager: SessionManagerLike;
  /** Session working directory, sourced from session_start ctx.cwd. */
  cwd: string;
  /** Per-session circuit breaker — trips on consecutive denials. */
  circuitBreaker: CircuitBreaker;
  /** Per-session verdict cache — avoids re-reviewing identical commands. */
  verdictCache: VerdictCache;
}

/**
 * Optional overrides for testing. In production (default export) all
 * fall back to real implementations.
 */
export interface AiGuardDependencies {
  /** Override config loading (inject mock config in tests). */
  loadConfig?: (cwd: string, trustedProject: boolean) => LoadConfigResult;
  /** Override model call (inject mock replies in tests). */
  completeSimple?: CompleteSimpleFn;
  /**
   * Override the authorizer factory (inject a stub to test lifecycle timing
   * without resolving the model stack). When set, `completeSimple` is not
   * used — the factory owns authorizer construction.
   */
  createPipeline?: (deps: ReviewPipelineDeps) => Authorizer["authorize"];
}

/**
 * Whether `error` is the exact "already registered" rejection from
 * `AuthorizerRegistry.register`. Used to distinguish a benign in-process
 * subagent re-registration (the child resolves the parent's service and
 * tries to re-register the link name) from a genuine registration failure.
 *
 * Exact match on the full message — not substring — so a different error
 * that merely contains "already registered" stays a warning.
 *
 * @param error - The caught error from `service.registerAuthorizer()`.
 * @param linkName - The link name passed to `registerAuthorizer`.
 * @returns True if `error` is the duplicate-registration rejection for `linkName`.
 */
function isDuplicateAuthorizerError(error: unknown, linkName: string): boolean {
  return (
    error instanceof Error &&
    error.message === `An authorizer is already registered for '${linkName}'.`
  );
}

export function createAiGuardExtension(
  pi: ExtensionAPI,
  dependencies: AiGuardDependencies = {},
): void {
  const loadConfig =
    dependencies.loadConfig ??
    ((cwd: string, trustedProject: boolean) => loadAiGuardConfig({ cwd, trustedProject }));

  let session: SessionState | undefined;
  let registered = false;
  let dispose: (() => void) | undefined;

  // Model calls go through `provider.streamSimple(...).result()` via the
  // ModelRegistry handed to extensions, avoiding the deprecated
  // `@earendil-works/pi-ai/compat` entrypoint.
  const completeSimple: CompleteSimpleFn =
    dependencies.completeSimple ?? createCompleteSimple(() => session?.registry);

  // The authorizer factory defaults to the real ReviewPipeline. Tests inject
  // a stub to exercise lifecycle timing without the model stack.
  const createPipeline = dependencies.createPipeline ?? createReviewPipeline;

  function tryRegister(): void {
    if (registered || !session?.config) {
      return;
    }
    const service = getPermissionsService();
    if (!service) {
      return;
    }
    try {
      const deps: ReviewPipelineDeps = {
        config: session.config,
        registry: session.registry,
        sessionManager: session.sessionManager,
        cwd: session.cwd,
        circuitBreaker: session.circuitBreaker,
        verdictCache: session.verdictCache,
        completeSimple,
      };
      const authorize = createPipeline(deps);
      dispose = service.registerAuthorizer(LINK_NAME, authorize);
      registered = true;
    } catch (e) {
      // "already registered" fires on every in-process subagent startup: the
      // child resolves the parent's globally-published service (it never
      // publishes its own) and tries to re-register the link name the parent
      // already owns. This is benign — the child reuses the parent's
      // authorizer — so downgrade to debug to avoid per-subagent warning spam.
      // Stale-registration failures (/reload dispose glitch) look identical
      // from this side, but they are rare and still surface here at debug
      // level for anyone diagnosing a missing authorizer.
      //
      // Exact match (not substring) so a different error that happens to
      // contain "already registered" stays a warning. The message format is
      // `An authorizer is already registered for '<name>'.` — see
      // AuthorizerRegistry.register in @gotgenes/pi-permission-system.
      if (isDuplicateAuthorizerError(e, LINK_NAME)) {
        debug(
          `Authorizer link already registered (likely subagent): ${e instanceof Error ? e.message : String(e)}`,
        );
      } else {
        warn(`Failed to register authorizer: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const result = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    session = {
      config: result.config,
      registry: ctx.modelRegistry,
      sessionManager: ctx.sessionManager,
      cwd: ctx.cwd,
      circuitBreaker: new CircuitBreaker(),
      verdictCache: new VerdictCache(),
    };
    for (const issue of result.issues) {
      warn(`config issue at ${issue.sourcePath ?? "(merged)"} — ${issue.path}: ${issue.message}`);
    }
    tryRegister();
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
    // permissions:ready may fire before or after session_start's handler
    // runs. If we're already registered, dispose first so we re-register
    // against the fresh service. Otherwise just attempt registration.
    if (registered) {
      dispose?.();
      dispose = undefined;
      registered = false;
    }
    tryRegister();
  });

  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
    registered = false;
    session = undefined;
  });
}
