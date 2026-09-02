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
 * behind the `registered` guard, because their relative order within a
 * session is not guaranteed — but v27 fires ready at least once per
 * session and may repeat (per node: at its session_start after the node
 * published its service, then again idempotently at its first
 * before_agent_start), so whichever fires first registers and every later
 * emission is a no-op: register once per session, for the session's own
 * node. The session itself is NEVER rebuilt on permissions:ready (breaker
 * counts and cache entries survive).
 *
 * The v27 service locator is keyed by session id: each node (root AND
 * in-process subagent children) publishes its own service, and this link
 * registers on the node's own. The id arrives from two sources:
 * `permissions:ready` carries it in its payload (the official source —
 * upstream: "Take sessionId from the permissions:ready payload"), and — as
 * a host-floor fallback for nodes whose payload carries null — the
 * session_start ctx self-read ({@link readSessionId}). Hosts without a
 * session id anywhere have no keyed service: the guard skips registration
 * there (every ask defers, the same observable as "no service published").
 *
 * The single registration slot rests on the v27 host contract: one
 * extension instance per session node — every node (root AND subagent
 * child) runs with its OWN ExtensionContext (upstream ADR 0012: "its own
 * ExtensionContext, event bus, gates"), so this instance never observes
 * another node's session events. A host that dispatched multiple nodes
 * through one instance would break the register-once contract
 * (unsupported).
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
 * warned (a stale registration means an old pipeline still governs asks),
 * never fatal.
 */

import {
  type Authorizer,
  type PermissionsReadyEvent,
  getPermissionsService,
} from "@gotgenes/pi-permission-system";

import type { SessionManagerLike } from "#src/ask/transcript-stripper.ts";
import { type LoadConfigResult } from "#src/config/config-layer.ts";
import { LINK_NAME } from "#src/config/config-schema.ts";
import { NOTIFY_PREFIX, warn, type NotifyLevel } from "#src/logger.ts";
import { type CompleteSimpleFn, type ModelRegistryLike } from "#src/model/model-review.ts";
import { type BreakerTier, CircuitBreaker } from "#src/review/circuit-breaker.ts";
import { type DenyRecord, type ReviewPipelineDeps } from "#src/review/review-pipeline.ts";
import { VerdictCache } from "#src/review/verdict-cache.ts";

import type { AiGuardUiContext } from "./runtime-settings.ts";
import { effectiveOverride, type SessionOverrides } from "./session-overrides.ts";

/** What a session_start hands the lifecycle: the session's own inputs. */
export interface SessionSeed {
  /** Validated extension config, or undefined if loading failed (fail-safe). */
  config: LoadConfigResult["config"];
  /** Model registry from the session context — resolves the reviewer model. */
  registry: ModelRegistryLike;
  /**
   * Session manager for transcript stripping (trusted intent + tool calls)
   * and the fallback session-id read ({@link readSessionId}).
   */
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
 * KEPT across permissions:ready (ready only completes a missing
 * registration; the session and the registered link are never rebuilt).
 */
export interface SessionState extends SessionSeed {
  /** Per-session circuit breaker — trips on consecutive denials. */
  circuitBreaker: CircuitBreaker;
  /** Per-session verdict cache — avoids re-reviewing identical commands. */
  verdictCache: VerdictCache;
  /** Per-session model-gate denies (the /ai-guard denied panel's data). */
  denyHistory: DenyRecord[];
}

/** Injectable collaborators the lifecycle registers the pipeline with. */
export interface SessionLifecycleDeps {
  /** The authorizer factory (the real ReviewPipeline, or a stub in tests). */
  createPipeline: (deps: ReviewPipelineDeps) => Authorizer["authorize"];
  /** Model-call function (lazy registry resolution happens per call). */
  completeSimple: CompleteSimpleFn;
}

/**
 * Whether `error` is the exact "already registered" rejection from
 * `AuthorizerRegistry.register`. Used to distinguish a stale registration
 * (the /reload dispose glitch) from a genuine registration failure.
 *
 * Exact match on the full message — not substring — so a different error
 * that merely contains "already registered" stays a generic warning. The
 * message is the contract today: upstream explicitly defers a typed
 * error code (pi-packages #702) — when one lands, migrate this check to
 * it.
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

/**
 * Read the host's session id, never throwing. Mirrors upstream's
 * `readSessionId` shape (hosts at the peer floor may lack
 * `SessionManager.getSessionId`; a missing id means the node publishes no
 * keyed permissions service). This is the FALLBACK source — the official
 * source is the `permissions:ready` payload; this read covers nodes whose
 * payload carries null.
 *
 * @param sessionManager - The session manager from the session ctx.
 * @returns The session id, or null when the host has none.
 */
export function readSessionId(sessionManager: SessionManagerLike): string | null {
  try {
    return sessionManager.getSessionId() || null;
  } catch {
    return null;
  }
}

/**
 * Rank order of the TUI notify levels — the threshold comparison's
 * arithmetic. Module-level: pure, no captured state.
 *
 * @param level - A TUI notify level.
 * @returns The level's rank (higher = more severe).
 */
function notifyLevelRank(level: NotifyLevel): number {
  return ["info", "warning", "error"].indexOf(level);
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
  /**
   * The node's session id — keys the per-node permissions service. Sources:
   * the `permissions:ready` payload (official; adopted on every emission)
   * and the session_start self-read (fallback, reset at each session_start).
   */
  #sessionId: string | null = null;
  /** Allocated exactly once; reset in place, never re-created (see header). */
  readonly #overrides: SessionOverrides = {};
  readonly #deps: SessionLifecycleDeps;

  /**
   * The single notify primitive: prefix, session lookup, and the
   * disposed-runner guard all live HERE — every notify in the extension
   * routes through it, so no call site can forget the prefix or crash the
   * verdict path. Best-effort by design: a lost message is warned, never
   * thrown.
   *
   * @param message - The bare message (no prefix — this function owns it).
   * @param level - The notification level.
   */
  #safeNotify(message: string, level?: NotifyLevel): void {
    try {
      const target = this.#session;
      if (!target) return;
      target.ctx.ui.notify(`${NOTIFY_PREFIX} ${message}`, level);
    } catch (e) {
      // The disposed-runner window is expected, but a lost escalation
      // message must not be silent: in manual mode this notify is the
      // only channel carrying the reviewer's reasoning to a human
      // about to adjudicate.
      warn(
        `notify failed (${e instanceof Error ? e.message : String(e)}) — escalation message lost: ${message}`,
      );
    }
  }

  /**
   * The pipeline's notify: ambient (review-loop) traffic, gated by the
   * effective notifyLevel (config default + session override, read
   * per-call so `/ai-guard notify-level …` takes effect on the next ask).
   * `off` silences all ambient lines — the operator's explicit choice;
   * the blindness tradeoff is documented in the README.
   *
   * @param message - The bare message.
   * @param level - The notification level.
   */
  #ambientNotify = (message: string, level?: NotifyLevel): void => {
    const session = this.#session;
    if (!session) return;
    const threshold = effectiveOverride(this.#overrides, session.config, "notifyLevel");
    if (threshold === "off") return;
    // Rank order mirrors the TUI levels; an unset level defaults to info
    // (the host's own default for ui.notify).
    if (threshold !== undefined && notifyLevelRank(level ?? "info") < notifyLevelRank(threshold))
      return;
    this.#safeNotify(message, level);
  };

  /**
   * The ungated notify: command feedback (a synchronous answer to an
   * explicit user action — silence on a command the user just typed reads
   * as breakage) AND the guard-absent errors (a fail-safe config start, a
   * failed or stale registration) — neither may hide behind the
   * notifyLevel threshold, unlike the pipeline's ambient channel.
   *
   * @param message - The bare message.
   * @param level - The notification level.
   */
  readonly feedbackNotify = (message: string, level?: NotifyLevel): void => {
    this.#safeNotify(message, level);
  };

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
   * The `breaker reset` action's seam: clear the session's circuit
   * breaker and report which tier was tripped at the moment of the reset —
   * the UI formats the returned tier into its copy; the breaker's tier
   * vocabulary crosses no further than this result.
   *
   * @returns The tier that was tripped (undefined when already clear).
   * @throws When no session is active (the settings surface guards first).
   */
  resetBreaker(): BreakerTier | undefined {
    const session = this.#session;
    if (!session?.config) {
      throw new Error("no active session — circuit breaker unavailable");
    }
    return session.circuitBreaker.resetAll(session.config.circuitBreaker);
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
    // The fallback id read — replaced wholesale at each session_start so a
    // new session can never inherit the previous one's id. A later
    // permissions:ready payload (the official source) may upgrade it.
    this.#sessionId = readSessionId(seed.sessionManager);
    this.#session = {
      ...seed,
      circuitBreaker: new CircuitBreaker(),
      verdictCache: new VerdictCache(),
      denyHistory: [],
    };
    // A fail-safe session start (config failed validation) means the
    // guard runs UNREVIEWED — the operator believes a reviewer stands in
    // front of asks and none does. That is error-grade, and it rides the
    // feedback channel (a direct answer to the session starting, not
    // ambient review-loop traffic) so no notifyLevel threshold can hide it.
    if (!seed.config) {
      this.feedbackNotify(
        "config failed to load — running in fail-safe mode with no auto-review; fix the config and restart the session",
        "error",
      );
    }
    // Total in-place reset: clearing every key (not an enumerated field
    // list) makes "forgot to reset the second setting someday" impossible
    // by construction — a new session starts from the config values.
    for (const key of Object.keys(this.#overrides) as (keyof SessionOverrides)[]) {
      delete this.#overrides[key];
    }
    this.#tryRegister();
  }

  /**
   * Permissions:ready fired. v27 fires ready at least once per session and
   * may repeat (a latch re-emits it at the node's first before_agent_start).
   * The payload carries the node's own session id — the official source
   * (upstream: "Take sessionId from the permissions:ready payload") — so a
   * non-null id is adopted (a null payload never clobbers a real one).
   * Register once per session, for the session's own node; the service it
   * resolves is stable for the session, so repeats must NOT dispose and
   * re-register — later emissions are no-ops.
   *
   * @param payload - The ready event payload; only `sessionId` is read
   *   (runtime-narrowed — the event bus is untyped at runtime).
   */
  onPermissionsReady(payload: PermissionsReadyEvent): void {
    const id = payload?.sessionId;
    if (typeof id === "string" && id !== "") {
      this.#sessionId = id;
    }
    if (this.#registered) return;
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
    this.#sessionId = null;
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
    if (!session?.config) {
      return;
    }
    // v27 keys the service locator per session node. No session id (neither
    // the ready payload nor the session_start self-read produced one) means
    // no keyed service — skip, asks defer.
    if (this.#sessionId === null) {
      return;
    }
    const service = getPermissionsService(this.#sessionId);
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
        denyHistory: session.denyHistory,
        overrides: this.#overrides,
        completeSimple: this.#deps.completeSimple,
        notify: this.#ambientNotify,
      };
      const authorize = this.#deps.createPipeline(deps);
      this.#dispose = service.registerAuthorizer(LINK_NAME, authorize);
      this.#registered = true;
    } catch (e) {
      if (isDuplicateAuthorizerError(e, LINK_NAME)) {
        // "already registered" is never benign in v27: every node owns its
        // service, so a duplicate means a STALE registration survived
        // disposal (the /reload dispose glitch) and still governs asks
        // with the previous session's deps.
        this.feedbackNotify(
          "stale ai-guard registration survived disposal — asks are governed by the previous session's pipeline (deferring to the prompt)",
          "error",
        );
        return;
      }
      this.feedbackNotify(
        `failed to register the reviewer — running with no auto-review (${e instanceof Error ? e.message : String(e)})`,
        "error",
      );
    }
  }
}
