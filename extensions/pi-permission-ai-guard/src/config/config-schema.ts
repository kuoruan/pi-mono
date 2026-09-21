import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";

import { isObjectRecord } from "#src/utils.ts";

export const EXTENSION_ID = "pi-permission-ai-guard";
export const LINK_NAME = "ai-guard";

/**
 * How the link disposes the reviewer's non-allow verdicts — the leniency
 * ladder, strictest first. Hard-tier denies (riskLevel high|critical, or
 * missing) always deny; the mode maps soft-tier denies (low|medium) and
 * the model's own uncertainty against the ladder. The ctrl+alt+g cycle
 * visits `default`, `lenient`, and `permissive`; only `strict` is set
 * explicitly (`/ai-guard mode strict`).
 */
export const MODE_VALUES = ["strict", "default", "lenient", "permissive"] as const;

/** How the link disposes model deny/defer verdicts (see the `mode` field comment). */
export type Mode = (typeof MODE_VALUES)[number];

/**
 * The notify-level thresholds — the minimum ambient level that still
 * notifies, plus `off` for total ambient silence. Command feedback
 * (the `/ai-guard` surface) is never gated.
 */
export const NOTIFY_LEVEL_VALUES = ["info", "warning", "error", "off"] as const;

/** The `notifyLevel` config value (ambient-notify threshold). */
export type NotifyThreshold = (typeof NOTIFY_LEVEL_VALUES)[number];

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

/**
 * The four System One question ids — a config-level contract. The schema
 * validates instruction overlays against this list, and the Jev engine
 * builds its questions from it; both sides share the one source so a new
 * question is one entry, not two lists that can drift.
 */
export const JEV_QUESTION_IDS = [
  "danger_category",
  "intent_match",
  "unconditionally_safe",
  "risk",
] as const;

/** Membership check for the overlay ids (string-keyed: config keys are strings). */
const JEV_QUESTION_ID_SET: ReadonlySet<string> = new Set(JEV_QUESTION_IDS);

/** One of the four System One question ids. */
export type JevQuestionId = (typeof JEV_QUESTION_IDS)[number];

/** A direct TypeSafe connection (object provider) — both fields optional. */
export const typesafeProviderSchema = z
  .object({
    type: z.literal("typesafe"),
    baseUrl: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

export type TypesafeProvider = z.infer<typeof typesafeProviderSchema>;

/** A Jev instruction overlay value: string, JSON object, or array (SDK EntryType). */
const jevInstructionValueSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.json()),
  z.array(z.json()),
]);

/**
 * `instructions` in Jev mode: shorthand string (shared background) or
 * `{ background?, questions? }` overlay. Unknown question ids and empty
 * objects are rejected by the cross-field checks below.
 */
const jevInstructionsSchema = z.union([
  z.string().min(1),
  z
    .object({
      background: jevInstructionValueSchema.optional(),
      questions: z.record(z.string().min(1), jevInstructionValueSchema).optional(),
    })
    .strict(),
]);

const configBaseSchema = z.object({
  model: z.string().min(1),
  reasoning: z.enum(REASONING_VALUES).default("off"),
  timeoutMs: z.number().int().min(1).max(300_000).default(15_000),
  // Reviewer reply budget: for a plain chat model 512 is plenty, but a
  // reasoning upstream (e.g. an alias onto a thinking model) spends the
  // budget on thinking blocks first — too small a cap truncates the reply
  // mid-think and surfaces as the empty-reply machinery failure. 4096
  // leaves headroom for both.
  maxTokens: z.number().int().min(16).max(32768).default(4096),

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

  // Jev behavior thresholds (object providers only).
  typesafe: z
    .object({
      booleanThreshold: z.number().min(0).max(1).default(0.5),
      confidenceFloor: z.number().min(0).max(1).default(0.5),
      // SDK timeout per attempt (retries cover 408/429/5xx only —
      // a timeout fails the call outright). Falls back to top-level
      // timeoutMs when omitted.
      timeoutMs: z.number().int().min(1).max(300_000).optional(),
    })
    .default({ booleanThreshold: 0.5, confidenceFloor: 0.5 }),

  // How the link disposes the reviewer's non-allow verdicts (the leniency
  // ladder, strictest first). Hard-tier denies (riskLevel high|critical,
  // or missing) always stay deny. Soft-tier denies (low|medium) and the
  // model's own uncertainty (split by its lean field — benign-leaned
  // doubts, neutral doubts, danger-leaned doubts) map per mode:
  // - "strict": everything denies — the reviewer's allow is the only pass.
  // - "default": you judge every flag but hard danger — soft denies and
  //   every unresolved doubt (any lean) ask.
  // - "lenient": benign and neutral doubts pass; soft denies and
  //   danger-leaned doubts ask.
  // - "permissive": everything passes except hard-tier denies.
  // Reviewer machinery failures never map to allow in any mode: they deny
  // under "strict" and "permissive" (a broken reviewer must not rubber-
  // stamp), and defer under the other two.
  mode: z.enum(MODE_VALUES).default("default"),

  // Ambient (review-loop) notification threshold. Levels mirror the TUI's
  // notify levels plus `off`; `error` currently has no ambient occupant
  // (ambient traffic is info/warning only) — the rung exists so the
  // threshold chain never skips a level. Command feedback is NOT gated.
  notifyLevel: z.enum(NOTIFY_LEVEL_VALUES).default("info"),

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

/**
 * Custom safety rules (`instructions`): LLM mode (string provider) takes
 * plain text replacing the built-in rules entirely, or null for the
 * built-ins; Jev mode (object provider) additionally accepts a
 * `{ background?, questions? }` overlay onto the built-ins.
 * `reasoning`/`maxTokens` are ignored in Jev mode.
 */
export const configSchema = z
  .union([
    configBaseSchema.extend({
      provider: z.string().min(1),
      instructions: z.string().min(1).nullable().default(null),
    }),
    configBaseSchema.extend({
      provider: typesafeProviderSchema,
      instructions: z
        .union([z.string().min(1), jevInstructionsSchema])
        .nullable()
        .default(null),
    }),
  ])
  .superRefine((config, ctx) => {
    // Overlay checks are Jev-only; object instructions on a string provider
    // are structurally impossible (the union's LLM member takes strings only).
    if (typeof config.provider !== "object") return;
    if (isObjectRecord(config.instructions)) {
      const overlay = config.instructions;
      if (overlay.background === undefined && overlay.questions === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["instructions"],
          message: "empty instructions overlay — set background and/or questions",
        });
      }
      for (const id of Object.keys(overlay.questions ?? {})) {
        if (!JEV_QUESTION_ID_SET.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["instructions", "questions", id],
            message: `unknown question id "${id}" — expected one of ${JEV_QUESTION_IDS.join(", ")}`,
          });
        }
      }
    }
  });

/** Validated extension configuration (zod schema inference). */
export type AiGuardConfig = z.infer<typeof configSchema>;

/** The config union's TypeSafe member (object provider — the Jev engine's config). */
export type TypesafeConfig = Extract<AiGuardConfig, { provider: TypesafeProvider }>;

/** The config union's registry member (string provider — the LLM engine's config). */
export type RegistryConfig = Extract<AiGuardConfig, { provider: string }>;

/**
 * The provider's runtime shape selects the engine; the config union's
 * members carry the pairing. This predicate narrows to the TypeSafe member.
 *
 * @param config - The validated config.
 * @returns True when the provider is a direct TypeSafe connection.
 */
export function hasTypesafeProvider(config: AiGuardConfig): config is TypesafeConfig {
  return typeof config.provider === "object";
}
