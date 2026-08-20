/**
 * Session identity and authorizer registration for the ai-guard link.
 *
 * One instance per extension instance owns three facts that must never
 * disagree:
 *
 * 1. `registered` ⇔ a `dispose` for the live registration exists;
 * 2. The registered pipeline's deps close over the CURRENT session's circuitBreaker/verdictCache
 *    (fresh per session — counters and cache entries never leak across sessions);
 * 3. The overrides object NEVER changes identity. It is allocated once here and reset in place at
 *    session_start, so every pipeline generation — and every runtime write (command, shortcut,
 *    restore, tree re-derive) — sees the same object. Re-creating it would leave an older
 *    registered pipeline closed over a stale object (the bug this module exists to make
 *    structurally impossible).
 *
 * Registration is attempted from both session_start and permissions:ready
 * behind the `registered` guard, because the relative order of the two
 * events is not guaranteed. The session itself is NOT rebuilt on
 * permissions:ready (breaker counts and cache entries survive — only the
 * authorizer link is re-registered against the fresh service).
 *
 * /reload reloads the extension module (a fresh instance, guard reset), but
 * the reload sequence emits session_shutdown to the old instance first
 * (which disposes the old registration), so the new instance registers
 * cleanly. A repeated session_start WITHOUT an intervening shutdown (pi
 * re-dispatches it on reload/fork) disposes the stale registration before
 * rebuilding — that is this module's one non-obvious rule.
 *
 * If a stale registration nonetheless remains (e.g. the dispose didn't take
 * effect), registerAuthorizer throws "already registered" — caught and
 * handled (silently for the benign subagent case, warned otherwise), never
 * fatal.
 */

import { type Authorizer, getPermissionsService } from "@gotgenes/pi-permission-system";

import { type LoadConfigResult } from "./config-loader.ts";
import { LINK_NAME } from "./config-schema.ts";
import { warn } from "./logger.ts";
import { type CompleteSimpleFn, type ModelRegistryLike } from "./model-review.ts";
import { type ReviewPipelineDeps } from "./review-pipeline.ts";
import type { AiGuardUiContext } from "./runtime-settings.ts";
import { CircuitBreaker, type SessionOverrides, VerdictCache } from "./session-state.ts";
import type { SessionManagerLike } from "./transcript-stripper.ts";

/**
 * The event-ctx subset stored on the session for authorize-time
 * notifications. Only `ui.notify` is used; the whole ctx object is stored
 * (never destructured) so pi's lazy, active-checked getters stay intact.
 */
/** What a session_start hands the lifecycle: the session's own inputs. */
export interface SessionSeed {
  /** Validated extension config, or undefined if loading failed (fail-safe). */
  config: LoadConfigResult["config"];
  /** Model registry from the session context — resolves the reviewer model. */
  registry: ModelRegistryLike;
  /** Session manager for transcript stripping (trusted intent + tool calls). */
  sessionManager: SessionManagerLike;
  /** Session working directory, sourced from session_start ctx.cwd. */
  cwd: string;
  /**
   * The most recent event ctx. Kept as the whole object (NOT destructured):
   * `ctx.ui` is a lazy getter that resolves at call time and asserts the
   * extension runner is still active, so a stored reference stays live
   * across the session. Used for authorize-time notifications. Typed as the
   * shared {@link AiGuardUiContext} — the stored value IS the full event
   * ctx, while only `notify` is consumed.
   */
  ctx: AiGuardUiContext;
}

/**
 * Per-session state. Created at session_start, cleared at session_shutdown.
 * KEPT across permissions:ready re-registration (the session itself hasn't
 * changed — only the authorizer link is re-registered).
 */
export interface SessionState extends SessionSeed {
  /** Per-session circuit breaker — trips on consecutive denials. */
  circuitBreaker: CircuitBreaker;
  /** Per-session verdict cache — avoids re-reviewing identical commands. */
  verdictCache: VerdictCache;
}

/** Injectable collaborators the lifecycle registers the pipeline with. */
export interface SessionLifecycleDeps {
  /** The authorizer factory (the real ReviewPipeline, or a stub in tests). */
  createPipeline: (deps: ReviewPipelineDeps) => Authorizer["authorize"];
  /** Model-call function (lazy registry resolution happens per call). */
  completeSimple: CompleteSimpleFn;
}

/**
 * Owns session identity and the authorizer registration.
 *
 * The interface is deliberately event-shaped: the extension wires pi's
 * session events to `onSessionStart` / `onPermissionsReady` / `onSessionTree`
 * / `onShutdown` and reads `session` / `overrides`. Everything else — the
 * re-register dance, deps assembly, the notify bridge — is implementation.
 */
export class SessionLifecycle {
  #session: SessionState | undefined;
  #registered = false;
  #dispose: (() => void) | undefined;
  /** Allocated exactly once; reset in place, never re-created (see header). */
  readonly #overrides: SessionOverrides = {};
  readonly #deps: SessionLifecycleDeps;

  /** @param deps - The pipeline factory and model-call function to register. */
  constructor(deps: SessionLifecycleDeps) {
    this.#deps = deps;
  }

  /**
   * The current session state, or undefined between shutdown and start.
   *
   * @returns The live session state, or undefined when no session is active.
   */
  get session(): SessionState | undefined {
    return this.#session;
  }

  /**
   * The stable overrides object. Identity never changes across sessions;
   * consumers mutate it in place (it is the single write path — there is no
   * second overrides field anywhere).
   *
   * @returns The session-scoped overrides object (stable identity).
   */
  get overrides(): SessionOverrides {
    return this.#overrides;
  }

  /**
   * A session started (or re-dispatched without shutdown on reload/fork):
   * replace the session state, reset the overrides in place, and register
   * against the fresh deps.
   *
   * @param seed - The session's inputs (config, registry, sessionManager,
   *   cwd, event ctx).
   */
  onSessionStart(seed: SessionSeed): void {
    this.#disposeRegistration();
    this.#session = {
      ...seed,
      circuitBreaker: new CircuitBreaker(),
      verdictCache: new VerdictCache(),
    };
    // Total in-place reset: clearing every key (not an enumerated field
    // list) makes "forgot to reset the second setting someday" impossible
    // by construction — a new session starts from the config values.
    for (const key of Object.keys(this.#overrides) as (keyof SessionOverrides)[]) {
      delete this.#overrides[key];
    }
    this.#tryRegister();
  }

  /** Permissions:ready fired: re-register against the fresh service. */
  onPermissionsReady(): void {
    this.#disposeRegistration();
    this.#tryRegister();
  }

  /**
   * Tree navigation (branch/rewind): re-point the stored event ctx so
   * authorize-time notifications route through the new branch's context.
   *
   * @param ctx - The session_tree event ctx.
   */
  onSessionTree(ctx: AiGuardUiContext): void {
    if (!this.#session) return;
    this.#session.ctx = ctx;
  }

  /** The session ended: dispose the registration and drop the session. */
  onShutdown(): void {
    this.#disposeRegistration();
    this.#session = undefined;
  }

  /** Dispose the live registration, if any (the re-register dance, once). */
  #disposeRegistration(): void {
    if (!this.#registered) return;
    this.#dispose?.();
    this.#dispose = undefined;
    this.#registered = false;
  }

  #tryRegister(): void {
    if (this.#registered) return;
    const session = this.#session;
    const service = getPermissionsService();
    if (!service || !session?.config) {
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
        overrides: this.#overrides,
        completeSimple: this.#deps.completeSimple,
        // Best-effort human notification for verdicts that escalate to the
        // user. Calls go through the stored event ctx (lazy getters); the
        // try/catch covers the disposed-runner window between an authorize
        // call in flight and session_shutdown — a notification must never
        // take the verdict path down with it.
        notify: (message, level) => {
          try {
            this.#session?.ctx.ui.notify(message, level);
          } catch (e) {
            // The disposed-runner window is expected, but a lost escalation
            // message must not be silent: in manual mode this notify is the
            // only channel carrying the reviewer's reasoning to a human
            // about to adjudicate.
            warn(
              `notify failed (${e instanceof Error ? e.message : String(e)}) — escalation message lost: ${message}`,
            );
          }
        },
      };
      const authorize = this.#deps.createPipeline(deps);
      this.#dispose = service.registerAuthorizer(LINK_NAME, authorize);
      this.#registered = true;
    } catch (e) {
      // "already registered" fires on every in-process subagent startup: the
      // child resolves the parent's globally-published service (it never
      // publishes its own) and tries to re-register the link name the parent
      // already owns. This is benign — the child reuses the parent's
      // authorizer — so silently skip: it fires per-subagent and carries no
      // actionable info. Stale-registration failures (/reload dispose
      // glitch) look identical and are rare; the missing-authorizer symptom
      // (all asks defer to the prompt) is the diagnostic signal.
      //
      // NOTE: in a subagent child the parent's authorizer governs verdicts,
      // so the child's own session overrides (its /ai-guard surface) are
      // inert — verdicts follow the parent session's mode. The child's
      // settings UI is not worth guarding against here: subagent sessions
      // are tool-driven, not dialog-driven.
      if (isDuplicateAuthorizerError(e, LINK_NAME)) {
        return;
      }
      warn(`Failed to register authorizer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Whether `error` is the exact "already registered" rejection from
 * `AuthorizerRegistry.register`. Used to distinguish a benign in-process
 * subagent re-registration from a genuine registration failure.
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
