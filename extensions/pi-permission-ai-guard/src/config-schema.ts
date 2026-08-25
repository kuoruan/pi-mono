import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";

export const EXTENSION_ID = "pi-permission-ai-guard";
export const LINK_NAME = "ai-guard";

/**
 * Who adjudicates the model's non-allow verdicts — the human-involvement
 * dial, also the /ai-guard shortcut cycle order (from `default`, one press
 * reaches `auto`).
 */
export const MODE_VALUES = ["manual", "default", "auto"] as const;

/** How the link disposes model deny/defer verdicts (see the `mode` field comment). */
export type Mode = (typeof MODE_VALUES)[number];

/** Verdicts the circuit breaker can force when it trips. */
export const BREAKER_VERDICT_VALUES = ["deny", "defer"] as const;

/** Verdict the circuit breaker forces on trip. */
export type BreakerVerdict = (typeof BREAKER_VERDICT_VALUES)[number];

/**
 * Thinking levels the reviewer model accepts — pi-ai's `ModelThinkingLevel`
 * vocabulary ("off" = don't pass the reasoning option; providers clamp
 * unsupported levels per model). Tied to the upstream type via `satisfies`.
 */
export const REASONING_VALUES: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const configSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.enum(REASONING_VALUES).default("off"),
  timeoutMs: z.number().int().min(1).max(300_000).default(15_000),

  // Transcript stripping: how much context to keep for the model review.
  transcript: z
    .object({
      maxUserMessages: z.number().int().min(1).max(50).default(5),
      maxToolCalls: z.number().int().min(1).max(50).default(10),
      maxCharsPerEntry: z.number().int().min(100).max(20_000).default(1000),
    })
    .default({ maxUserMessages: 5, maxToolCalls: 10, maxCharsPerEntry: 1000 }),

  // Surfaces to review. Glob-style patterns where `*` matches any
  // character sequence:
  // - "*": all surfaces (use this with excludes for a broad allow-list)
  // - "namespace:*": all tools under a namespace
  // - "*:bar": `bar` under any namespace
  // - "*:*": any namespaced surface
  // - exact name (e.g. "bash", "mcp", "skill")
  // - "!pattern": exclude a pattern (takes priority over inclusions)
  // Empty array = review nothing. Excludes-only (no includes) = review nothing.
  surfaces: z.array(z.string().min(1)).default(["bash", "mcp", "skill"]),

  // Custom safety rules for the full review. When provided, replaces the
  // built-in rules entirely; the verdict output format is always appended.
  // null = use the built-in rules.
  instructions: z.string().min(1).nullable().default(null),

  // Who adjudicates the review verdicts (the link's mapping of model deny and
  // defer; allow always passes through untouched):
  // - "default": model denies are terminal; defers pass to the next
  //   authority (the interactive prompt in a TUI session; the denying
  //   terminal headless). The shipped behavior.
  // - "manual": the human adjudicates everything the model doesn't allow —
  //   denies are mapped to defers, so the human can override the model.
  // - "auto": fully automatic, fail-closed — denies stay terminal AND
  //   the model's own uncertainty is denied too (the link never interrupts
  //   the agent on a normal model verdict; reviewer machinery failures and
  //   an explicitly configured breaker `defer` still reach the human escape
  //   valve, with a notification explaining the interruption).
  mode: z.enum(MODE_VALUES).default("default"),

  // Circuit breaker (session-level, fail-safe). `consecutive` is recoverable
  // (resets on trip so the model gets another chance); `total` is a hard
  // session cap (never resets, so once tripped it stays tripped).
  circuitBreaker: z
    .object({
      consecutive: z.number().int().min(1).max(50).default(3),
      total: z.number().int().min(1).max(200).default(20),
      verdict: z.enum(BREAKER_VERDICT_VALUES).default("deny"),
    })
    .default({ consecutive: 3, total: 20, verdict: "deny" }),

  // Verdict cache (session-level LRU). 0 disables; only commands that reach
  // the model (policy "ask") are cached. contextHash from trusted intent
  // invalidates entries when the conversation moves on. Defaults to 128:
  // repeated commands (git status, ls, pnpm test) hit the cache on the second
  // call — zero model cost, zero latency.
  cache: z
    .object({
      maxEntries: z.number().int().min(0).max(1000).default(128),
    })
    .default({ maxEntries: 128 }),
});

/** Validated extension configuration (zod schema inference). */
export type AiGuardConfig = z.infer<typeof configSchema>;
