import { z } from "zod";

export const EXTENSION_ID = "pi-permission-ai-guard";
export const LINK_NAME = "ai-guard";

export const configSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.enum(["off", "low", "medium", "high"]).default("off"),
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

  // Circuit breaker (session-level, fail-safe). `consecutive` is recoverable
  // (resets on trip so the model gets another chance); `total` is a hard
  // session cap (never resets, so once tripped it stays tripped).
  circuitBreaker: z
    .object({
      consecutive: z.number().int().min(1).max(50).default(3),
      total: z.number().int().min(1).max(200).default(20),
      verdict: z.enum(["deny", "defer"]).default("deny"),
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
