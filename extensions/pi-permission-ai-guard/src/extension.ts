/**
 * Extension wiring: load config at session_start, keep the "ai-guard"
 * chain link registered against the current session ({@link SessionLifecycle}),
 * and expose the runtime settings surface ({@link RuntimeSettings}).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Authorizer, PERMISSIONS_READY_CHANNEL } from "@gotgenes/pi-permission-system";

import { type LoadConfigResult, loadAiGuardConfig } from "./config-loader.ts";
import { MODE_VALUES } from "./config-schema.ts";
import { warn } from "./logger.ts";
import { type CompleteSimpleFn, createCompleteSimple } from "./model-review.ts";
import { type ReviewPipelineDeps, createReviewPipeline } from "./review-pipeline.ts";
import { RuntimeSettings, type EnumSettingSpec } from "./runtime-settings.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";

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
 * The settings this extension exposes: enum-valued overrides over their
 * same-named config fields. The whole /ai-guard UX materializes from
 * this list (see {@link RuntimeSettings}).
 */
const SETTINGS: readonly EnumSettingSpec[] = [
  // `default` is the shipped baseline — a footer line saying "default"
  // permanently would be pure noise, so RuntimeSettings omits it.
  { name: "mode", values: [...MODE_VALUES], hiddenValue: "default" },
];

export function createAiGuardExtension(
  pi: ExtensionAPI,
  dependencies: AiGuardDependencies = {},
): void {
  const loadConfig =
    dependencies.loadConfig ??
    ((cwd: string, trustedProject: boolean) => loadAiGuardConfig({ cwd, trustedProject }));

  // The lifecycle owns session identity, the registration, and the stable
  // overrides object; the settings surface reads/writes overrides through
  // that same object (the single write path).
  const lifecycle = new SessionLifecycle({
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
    { session: lifecycle, appendEntry: (type, data) => pi.appendEntry(type, data) },
    SETTINGS,
  );

  pi.registerCommand("ai-guard", settings.command);
  pi.registerShortcut("ctrl+alt+g", settings.shortcut);

  pi.on("session_start", (_event, ctx) => {
    const result = loadConfig(ctx.cwd, ctx.isProjectTrusted());
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

  pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
    lifecycle.onPermissionsReady();
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
    settings.clearFooter(ctx);
  });
}
