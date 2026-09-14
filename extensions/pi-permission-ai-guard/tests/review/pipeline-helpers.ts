/**
 * Shared helpers for the review-pipeline suites: one definition of the
 * model/query/log/notify doubles and the pipeline assembly so the three
 * split files (core verdicts, mode semantics, stateful devices) cannot
 * drift on their fixtures.
 */

import type { Api, AssistantMessage, Model, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PermissionCheckResult, PermissionQuery } from "@gotgenes/pi-permission-system";
import { expect } from "vitest";

import { type AiGuardConfig, configSchema } from "#src/config/config-schema.ts";
import { CircuitBreaker } from "#src/review/circuit-breaker.ts";
import type {
  NotifyFn,
  ReviewPipelineDeps,
  createReviewPipeline,
} from "#src/review/review-pipeline.ts";
import { VerdictCache } from "#src/review/verdict-cache.ts";
import { withAgentInstruction } from "#src/review/verdict-mode.ts";
import { makeDetails } from "#test/fixtures.ts";

export const baseConfig: AiGuardConfig = configSchema.parse({
  provider: "anthropic",
  model: "test-model",
  cache: { maxEntries: 0 },
});

export function makeFakeCompleteSimple(
  replyContent: AssistantMessage["content"],
): (
  _model?: Model<Api>,
  _context?: Context,
  _options?: SimpleStreamOptions,
) => Promise<AssistantMessage> {
  return async (): Promise<AssistantMessage> =>
    ({
      role: "assistant",
      content: replyContent,
      stopReason: "toolUse",
      api: "anthropic-messages",
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        total: 150,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }) as AssistantMessage;
}

export function makeSessionManagerWith(entries: unknown[]) {
  return {
    getSessionId: () => "s1",
    buildContextEntries: () => entries as unknown as SessionEntry[],
  };
}

/**
 * A PermissionQuery whose checkPermission returns the given state.
 *
 * @param state - The policy state to return.
 * @returns A `PermissionQuery` stub.
 */
export function makeQuery(state: PermissionCheckResult["state"]): PermissionQuery {
  const result = { state } as unknown as PermissionCheckResult;
  return {
    checkPermission: () => result,
    getToolPermission: () => state,
  };
}

/**
 * A query whose checkPermission records calls for assertions.
 *
 * @param state - The policy state to return.
 * @returns The query and a `calls` array recording each checkPermission invocation.
 */
export function makeRecordingQuery(state: PermissionCheckResult["state"]): {
  query: PermissionQuery;
  calls: { surface: string; value: string | undefined; agentName?: string }[];
} {
  const calls: { surface: string; value: string | undefined; agentName?: string }[] = [];
  const result = { state } as unknown as PermissionCheckResult;
  const query: PermissionQuery = {
    checkPermission: (surface, value, agentName) => {
      calls.push({ surface, value, agentName });
      return result;
    },
    getToolPermission: () => state,
  };
  return { query, calls };
}

export const fakeModel = { provider: "test", id: "test-model" } as unknown as Model<Api>;

export const noLog = { review: () => {}, debug: () => {} } as never;

/** A recorded log emission. */
export interface RecordedLog {
  event: string;
  data: Record<string, unknown>;
}

/**
 * A log pair that records every review/debug emission for assertions — the
 * once-per-test collector boilerplate collapsed to one call.
 *
 * @returns The recording log and its collected review/debug emissions.
 */
export function makeRecordingLog(): {
  log: {
    review: (event: string, data: Record<string, unknown>) => void;
    debug: (event: string, data: Record<string, unknown>) => void;
  };
  reviewCalls: RecordedLog[];
  debugCalls: RecordedLog[];
} {
  const reviewCalls: RecordedLog[] = [];
  const debugCalls: RecordedLog[] = [];
  const log = {
    review: (event: string, data: Record<string, unknown>) => reviewCalls.push({ event, data }),
    debug: (event: string, data: Record<string, unknown>) => debugCalls.push({ event, data }),
  };
  return { log, reviewCalls, debugCalls };
}

/**
 * A notify spy that records (message, level) pairs — the once-per-test
 * notification boilerplate collapsed to one call.
 *
 * @returns The spy and its collected (message, level) pairs.
 */
export function makeNotifySpy(): {
  notifications: [string, string | undefined][];
  notify: NotifyFn;
} {
  const notifications: [string, string | undefined][] = [];
  const notify = (message: string, level?: string) => notifications.push([message, level]);
  return { notifications, notify };
}

/**
 * Authorize a default ask against a policy-ask query and assert the
 * emitted verdict — the common three-liner collapsed to one call.
 *
 * A `deny` expectation asserts the reason as `baseReason — instruction`:
 * terminal denies carry the agent-facing instruction appended by the
 * pipeline (the audit/notify copies keep the bare reason).
 *
 * @param authorize - The pipeline's authorize function.
 * @param details - `makeDetails` overrides for the ask.
 * @param expected - The expected emitted verdict (`reason` on a deny is
 *   the base reason the instruction is appended to).
 * @param state - The policy state the query reports (default "ask").
 * @param denySource - The expected instruction variant for a deny
 *   (default `"content"`; `"machinery"` for reviewer-failure denies).
 */
export async function expectVerdict(
  authorize: ReturnType<typeof createReviewPipeline>,
  details: Record<string, unknown>,
  expected: { kind: string; reason?: string },
  state: PermissionCheckResult["state"] = "ask",
  denySource: "content" | "machinery" = "content",
): Promise<void> {
  const verdict = await authorize(makeDetails(details), makeQuery(state), noLog);
  // A deny's expectation is the base reason with the agent instruction
  // appended (terminal denies carry it); anything else asserts as-is.
  const expectedVerdict =
    expected.kind === "deny"
      ? {
          kind: "deny",
          reason: withAgentInstruction(expected.reason, denySource),
        }
      : expected;
  expect(verdict).toEqual(expectedVerdict);
}

/**
 * Default registry with model + auth resolved.
 *
 * @param overrides - Optional `find`/`getApiKeyAndHeaders` overrides for
 *   failure-path fixtures (unresolved model, auth errors, throws).
 * @returns A model registry stub.
 */
export const defaultRegistry = (
  overrides: Partial<{
    find: ReviewPipelineDeps["registry"]["find"];
    getApiKeyAndHeaders: ReviewPipelineDeps["registry"]["getApiKeyAndHeaders"];
  }> = {},
): ReviewPipelineDeps["registry"] => ({
  find: () => fakeModel,
  getProvider: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
  ...overrides,
});

/**
 * Build a ReviewPipeline from resolved session state. Overrides replace the
 * direct values (not lazy getters) — the pipeline closes over them once.
 *
 * @param overrides - Optional `ReviewPipelineDeps` overrides.
 * @returns The assembled `ReviewPipelineDeps`.
 */
export function makePipeline(overrides: Partial<ReviewPipelineDeps> = {}): ReviewPipelineDeps {
  return {
    config: baseConfig,
    registry: defaultRegistry(),
    sessionManager: makeSessionManagerWith([]),
    cwd: "/project",
    circuitBreaker: new CircuitBreaker(),
    verdictCache: new VerdictCache(),
    denyHistory: [],
    overrides: {},
    completeSimple: makeFakeCompleteSimple([{ type: "text", text: '{"verdict":"allow"}' }]),
    // Required in production (the lifecycle's notify bridge); tests that
    // don't assert notifications get a no-op.
    notify: () => {},
    ...overrides,
  };
}

