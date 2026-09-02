/**
 * Extension wiring: load config at session_start, keep the "ai-guard"
 * chain link registered against the current session ({@link SessionLifecycle}),
 * and expose the runtime settings surface ({@link RuntimeSettings}).
 */

import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Authorizer,
  PERMISSIONS_READY_CHANNEL,
  type PermissionsReadyEvent,
} from "@gotgenes/pi-permission-system";

import { readDecisionLog } from "#src/audit/decision-log-reader.ts";
import { readTailLinesFromFile } from "#src/audit/log-tail-fs.ts";
import {
  type ConfigEnv,
  type LoadConfigResult,
  type SaveConfigFn,
  loadAiGuardConfig,
  persistConfigLayer,
} from "#src/config/config-layer.ts";
import { MODE_VALUES, NOTIFY_LEVEL_VALUES } from "#src/config/config-schema.ts";
import { CYCLE_MODE_VALUES, EMPHASIZED_MODE, MODE_BLURBS } from "#src/config/mode-table.ts";
import { warn } from "#src/logger.ts";
import { type CompleteSimpleFn, createCompleteSimple } from "#src/model/model-review.ts";
import { type ReviewPipelineDeps, createReviewPipeline } from "#src/review/review-pipeline.ts";
import { RuntimeSettings, type EnumSettingSpec } from "#src/session/runtime-settings.ts";
import { SessionLifecycle } from "#src/session/session-lifecycle.ts";

/**
 * Optional overrides for testing. In production (default export) all
 * fall back to real implementations.
 */
export interface AiGuardDependencies {
  /** Override config loading (inject mock config in tests). */
  loadConfig?: (env: ConfigEnv) => LoadConfigResult;
  /** Override model call (inject mock replies in tests). */
  completeSimple?: CompleteSimpleFn;
  /**
   * Override the authorizer factory (inject a stub to test lifecycle timing
   * without resolving the model stack). When set, `completeSimple` is not
   * used — the factory owns authorizer construction.
   */
  createPipeline?: (deps: ReviewPipelineDeps) => Authorizer["authorize"];
  /** Override the config-layer persistence (the save-config actions). */
  saveConfig?: SaveConfigFn;
}
/**
 * The settings this extension exposes: enum-valued overrides over their
 * same-named config fields. The whole /ai-guard UX materializes from
 * this list (see {@link RuntimeSettings}).
 */
const SETTINGS: readonly EnumSettingSpec[] = [
  // `default` is the shipped baseline — a footer line saying "default"
  // permanently would be pure noise, so RuntimeSettings omits it. The
  // cycle subset and the warning-red emphasis derive from the ladder
  // table (mode-table.ts), not from hand-edited copies here.
  {
    name: "mode",
    values: [...MODE_VALUES],
    description: "how denials and uncertainty are disposed",
    hiddenValue: "default",
    cycleValues: CYCLE_MODE_VALUES,
    highlightValue: EMPHASIZED_MODE,
    optionDetails: MODE_BLURBS,
  },
  {
    // The ambient-notify threshold. `info` is the shipped baseline — same
    // footer rule as mode: only deviations render. No cycle membership
    // (ctrl+alt+g stays mode-only), no highlight (a quieter pane is a
    // preference, not a danger).
    name: "notifyLevel",
    commandName: "notify-level",
    values: [...NOTIFY_LEVEL_VALUES],
    description: "the ambient notify threshold",
    hiddenValue: "info",
  },
];

export function createAiGuardExtension(
  pi: ExtensionAPI,
  dependencies: AiGuardDependencies = {},
): void {
  // The live environment for the session. Replaced wholesale at each
  // session_start (no cross-session leakage); the config-layer module
  // resolves paths AND the project trust rule from it.
  let sessionEnv: ConfigEnv | undefined;
  const loadConfig = dependencies.loadConfig ?? ((env: ConfigEnv) => loadAiGuardConfig(env));

  // The lifecycle owns session identity, the registration, and the stable
  // overrides object; the settings surface reads/writes overrides through
  // that same object (the single write path).
  // Annotated (not inferred) because the completeSimple closure below
  // references `lifecycle` from its own initializer — an explicit type
  // removes the self-reference from type inference entirely.
  const lifecycle: SessionLifecycle = new SessionLifecycle({
    // The authorizer factory defaults to the real ReviewPipeline. Tests
    // inject a stub to exercise lifecycle timing without the model stack.
    createPipeline: dependencies.createPipeline ?? createReviewPipeline,
    // Model calls go through `provider.streamSimple(...).result()` via the
    // ModelRegistry handed to extensions, avoiding the deprecated
    // `@earendil-works/pi-ai/compat` entrypoint.
    completeSimple:
      dependencies.completeSimple ?? createCompleteSimple(() => lifecycle.session?.registry),
  });

  const settings = new RuntimeSettings(
    {
      session: lifecycle,
      appendEntry: (type, data) => pi.appendEntry(type, data),
      // Command feedback rides the session's notify seam (prefix +
      // disposed-runner guard live there); feedback is never level-gated.
      notify: lifecycle.feedbackNotify,
      // The production adapter is a pure pass-through: persistConfigLayer
      // owns the trust guard and the schema gate inside its interface.
      saveConfig:
        dependencies.saveConfig ??
        ((target, config) => {
          // Structurally unreachable (the settings command requires an
          // active session, which implies a session_start has set the
          // env) — kept as the typed floor for the undefined state.
          if (!sessionEnv) {
            return { path: "", created: false, changed: false, error: "no active session" };
          }
          return persistConfigLayer({ target, env: sessionEnv, config });
        }),
    },
    {
      // The read-only panels' collaborators: the report command's log read
      // (production reads the real review log's tail — read-only; the
      // reader's invariants forbid writes) and the session's live deny
      // history, read through an accessor because the array is recreated
      // at each session_start, after this wiring runs once.
      readDecisionLog: (home: string) =>
        readDecisionLog(home, { readTailLines: readTailLinesFromFile }),
      home: homedir(),
      readDenyHistory: () => lifecycle.session?.denyHistory ?? [],
    },
    SETTINGS,
  );

  pi.registerCommand("ai-guard", settings.command);
  pi.registerShortcut("ctrl+alt+g", settings.shortcut);

  pi.on("session_start", (_event, ctx) => {
    const env: ConfigEnv = { cwd: ctx.cwd, trustedProject: ctx.isProjectTrusted() };
    sessionEnv = env;
    const result = loadConfig(env);
    lifecycle.onSessionStart({
      config: result.config,
      registry: ctx.modelRegistry,
      sessionManager: ctx.sessionManager,
      cwd: ctx.cwd,
      ctx,
    });
    // Restore persisted setting overrides from the session file (a resumed
    // session picks up where it left off; a fresh one restores nothing),
    // then sync the footer (it renders only deviations from the default).
    settings.restore(ctx.sessionManager);
    settings.syncFooter(ctx);
    for (const issue of result.issues) {
      warn(`config issue at ${issue.sourcePath ?? "(merged)"} — ${issue.path}: ${issue.message}`);
    }
  });

  // v27: ready fires at least once per session and may repeat. The payload
  // carries the node's session id — the official source for the
  // session-keyed service locator (the lifecycle falls back to the
  // session_start ctx self-read for hosts whose payload is null) — and the
  // lifecycle registers once, guarding repeats. `adjudicatesLocally` is
  // intentionally ignored: the link registers on its own node's service
  // regardless of adjudication mode (upstream accepts links on relaying
  // nodes too).
  pi.events.on(PERMISSIONS_READY_CHANNEL, (payload) => {
    // pi's event bus is untyped — the channel contract IS this payload
    // shape (the lifecycle runtime-narrows the one field it reads).
    lifecycle.onPermissionsReady(payload as PermissionsReadyEvent);
  });

  pi.on("session_tree", (_event, ctx) => {
    // Tree navigation (branch/rewind) can move the active branch past
    // setting entries — re-derive the overrides from the new branch and
    // re-sync the footer (the todo.ts pattern: reconstruct on
    // session_start + session_tree).
    if (!lifecycle.session) return;
    lifecycle.onSessionTree(ctx);
    settings.restore(ctx.sessionManager);
    settings.syncFooter(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifecycle.onShutdown();
    sessionEnv = undefined; // no cross-session leakage (mirrors onSessionStart)
    settings.clearFooter(ctx);
  });
}
