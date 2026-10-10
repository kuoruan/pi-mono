/**
 * Shared harness for the live-model scripts: builds the review pipeline
 * against a real model. The caller supplies the model/provider and reads back
 * the verdict plus collected audit events.
 */

import {
  type Api,
  type Model,
  type Provider,
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  Authorizer,
  AuthorizerLog,
  PermissionQuery,
  PromptPayload,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import { DECISION_EVENT, MODEL_REPLY_EVENT } from "#src/audit/events.ts";
import type { AiGuardConfig } from "#src/config/config-schema.ts";
import type { ModelRegistryLike } from "#src/model/model-registry.ts";
import { buildReviewerPool } from "#src/review/build-pool.ts";
import { CircuitBreaker } from "#src/review/circuit-breaker.ts";
import { createModelCall } from "#src/review/engines/chat/call.ts";
import type { SessionManagerLike } from "#src/review/request/transcript-stripper.ts";
import { createReviewPipeline } from "#src/review/review-pipeline.ts";
import type { ReviewerEngine } from "#src/review/reviewer-engine.ts";
import { VerdictCache } from "#src/review/verdict-cache.ts";

export type ProviderName = "anthropic" | "openai" | "typesafe";
export type VerdictKind = "allow" | "deny" | "defer";

/** Both provider factories, widened to one type (their unions are incompatible). */
export type AnyProvider = Provider<Api>;

export const DEFAULT_BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
} as const;

/** The addressing fields a model needs (the CLI args' useful subset). */
export interface ModelSpec {
  provider: ProviderName;
  modelId: string;
  baseUrl: string | undefined;
  /**
   * True for a reasoning model even when thinking should be off: pi-ai emits
   * the explicit "thinking disabled" parameter only when this is true.
   */
  reasoning?: boolean;
}

export function buildModel(args: ModelSpec): Model<any> {
  const isAnthropic = args.provider === "anthropic";
  return {
    id: args.modelId,
    name: args.modelId,
    api: isAnthropic ? "anthropic-messages" : "openai-responses",
    provider: args.provider,
    baseUrl: args.baseUrl ?? (isAnthropic ? DEFAULT_BASE_URLS.anthropic : DEFAULT_BASE_URLS.openai),
    // Default true; the config's `reasoning` ("off") decides thinking.
    reasoning: args.reasoning ?? true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: isAnthropic ? 200_000 : 128_000,
    maxTokens: isAnthropic ? 8192 : 4096,
  };
}

export function buildProvider(provider: ProviderName): AnyProvider {
  return (provider === "openai" ? openaiProvider() : anthropicProvider()) as AnyProvider;
}

// ── Session helpers ─────────────────────────────────────────────────

export function emptySession(): SessionManagerLike {
  return { getSessionId: () => "s1", buildContextEntries: () => [] };
}

export function sessionWithUserMessages(messages: string[]): SessionManagerLike {
  const entries: SessionEntry[] = messages.map((text, i) => ({
    type: "message",
    id: String(i),
    parentId: i > 0 ? String(i - 1) : null,
    timestamp: String(i),
    message: { role: "user", content: text, timestamp: 0 },
  }));
  return { getSessionId: () => "s1", buildContextEntries: () => entries };
}

// A session whose malicious tool result tries to inject authorization.
export function sessionWithInjection(
  userIntent: string,
  maliciousToolResult: string,
): SessionManagerLike {
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "1",
      parentId: null,
      timestamp: "1",
      message: { role: "user", content: userIntent, timestamp: 0 },
    },
    {
      type: "message",
      id: "2",
      parentId: "1",
      timestamp: "2",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "cat README.md" } },
        ],
        api: "anthropic-messages",
        provider: "test",
        model: "test-model",
        stopReason: "toolUse",
        timestamp: 0,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    },
    {
      type: "message",
      id: "3",
      parentId: "2",
      timestamp: "3",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: maliciousToolResult }],
        isError: false,
        timestamp: 0,
      },
    },
  ];
  return { getSessionId: () => "s1", buildContextEntries: () => entries };
}

// ── Test harness ────────────────────────────────────────────────────

export interface TestCase {
  name: string;
  command: string;
  surface?: string;
  sessionManager?: SessionManagerLike;
  expected?: VerdictKind;
  expectedAny?: VerdictKind[];
}

export interface TestGroup {
  label: string;
  cases: TestCase[];
}

/** An ask-policy query that always routes to the model. */
export const ASK_QUERY: PermissionQuery = {
  checkPermission: () => ({ toolName: "bash", state: "ask", source: "default", origin: "builtin" }),
  getToolPermission: () => "ask",
};

/** A collected audit-log event (decision, short-circuit, or model reply). */
export interface LogEvent {
  event: string;
  details?: Record<string, unknown>;
}

// Build a fresh pipeline + event-collecting log for one case. The circuit
// breaker and verdict cache are per-case, so cases stay independent.
export function buildHarness(
  tc: TestCase,
  config: AiGuardConfig,
  model: Model<any> | null,
  apiKey: string,
  providerInstance: AnyProvider | null, // null on the classifier path (no registry)
): {
  authorize: Authorizer["authorize"];
  log: AuthorizerLog & { events: LogEvent[] };
} {
  // Chat endpoints on the classifier path resolve to "no registry"; the
  // classifier lane never touches it.
  const nullRegistry: ModelRegistryLike = {
    find: () => undefined,
    getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no registry" }),
    streamSimple: () => {
      throw new Error("no registry");
    },
  };
  // A fake registry serving only chat endpoints (null on the pure-classifier path).
  const poolEngine = (): ReviewerEngine => {
    const registry: ModelRegistryLike =
      model === null || providerInstance === null
        ? nullRegistry
        : {
            find: () => model,
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
            // Stand in for the agent's registry by delegating to the provider.
            streamSimple: (m, context, options) =>
              providerInstance.streamSimple(
                m,
                normalizeContext(context),
                options as SimpleStreamOptions | undefined,
              ),
          };
    return buildReviewerPool(config, {
      registry,
      modelCall: createModelCall(() => registry),
    });
  };
  const events: LogEvent[] = [];
  const log: AuthorizerLog & { events: LogEvent[] } = {
    events,
    review: (event, details) => events.push({ event, details }),
    debug: (event, details) => events.push({ event, details }),
  };
  const authorize = createReviewPipeline({
    config,
    engine: poolEngine(),
    sessionManager: tc.sessionManager ?? emptySession(),
    cwd: process.cwd(),
    circuitBreaker: new CircuitBreaker(),
    verdictCache: new VerdictCache(),
    denyHistory: [],
    overrides: {},
    notify: (message, level) => console.log(`[${level ?? "info"}] ${message}`),
  });
  return { authorize, log };
}

export function makeDetails(command: string, surface = "bash"): PromptPermissionDetails {
  return {
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: "tool_call" as const,
    agentName: null,
    payload: bashPayload(command, surface),
    surface,
    value: command,
  };
}

// Minimal PromptPayload for a fixture.
export function bashPayload(value: string, surface = "bash"): PromptPayload {
  return {
    kind: surface === "bash" ? "bash" : "tool",
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface,
      toolName: null,
      invokedToolName: null,
      value,
      matchedPattern: null,
      matchedSpelling: null,
      commandContext: null,
      executedUnit: null,
    },
    evidence: [],
    annotations: [],
  } as PromptPayload;
}

/** A convenience view of the `DECISION_EVENT` fields a verdict check reaches for. */
export interface DecisionFacts {
  /** What the link returned (post-mode-mapping). */
  verdict: string | undefined;
  /** The model's own judgment (pre-mapping). */
  reason: string | undefined;
  riskLevel: string | null | undefined;
  deferKind: string | null | undefined;
  lean: string | null | undefined;
  modelId: string | undefined;
  latencyMs: number | undefined;
  attempts: number | undefined;
  rawReply: unknown;
}

// Extract the analysis-relevant facts from a collected event list.
export function decisionFacts(events: LogEvent[]): DecisionFacts {
  const decision = events.find((e) => e.event === DECISION_EVENT)?.details as
    | Record<string, unknown>
    | undefined;
  const reply = events.find((e) => e.event === MODEL_REPLY_EVENT)?.details as
    | Record<string, unknown>
    | undefined;
  return {
    verdict: decision?.verdict as string | undefined,
    reason: decision?.reason as string | undefined,
    riskLevel: decision?.riskLevel as string | null | undefined,
    deferKind: decision?.deferKind as string | null | undefined,
    lean: decision?.lean as string | null | undefined,
    modelId: decision?.modelId as string | undefined,
    latencyMs: decision?.latencyMs as number | undefined,
    attempts: decision?.attempts as number | undefined,
    rawReply: reply?.rawReply ?? decision?.rawReply,
  };
}
