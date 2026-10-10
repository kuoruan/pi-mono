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
 * The System One question ids — a config-level contract. The schema
 * validates instruction overlays against this list, and the classifier engine
 * builds its questions from it; both sides share the one source so a new
 * question is one entry, not two lists that can drift.
 */
export const CLASSIFIER_QUESTION_IDS = ["danger_category", "intent_match", "risk"] as const;

/** Membership check for the overlay ids (string-keyed: config keys are strings). */
const CLASSIFIER_QUESTION_ID_SET: ReadonlySet<string> = new Set(CLASSIFIER_QUESTION_IDS);

/** One of the System One question ids. */
export type ClassifierQuestionId = (typeof CLASSIFIER_QUESTION_IDS)[number];

/**
 * How the registry provider resolves the model — pi's model-type
 * vocabulary (`ModelType`). Absent means chat; `classifier` selects pi's
 * built-in classifier models via `modelRegistry.classify` instead
 * of the direct TypeSafe connection. Closed set: the enum is this
 * extension's honest capability surface.
 */
export const MODEL_TYPE_VALUES = ["chat", "classifier"] as const;

/** A direct TypeSafe connection (object provider) — both fields optional. */
export const directProviderSchema = z
  .object({
    type: z.literal("typesafe"),
    baseUrl: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

export type DirectProvider = z.infer<typeof directProviderSchema>;

/**
 * One registry-resolved fallback: a chat model by default, or a pi
 * built-in classifier when `modelType` is `classifier`. Credentials
 * remain in Pi's model registry in both cases.
 */
export const registryFallbackSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    modelType: z.enum(MODEL_TYPE_VALUES).default("chat"),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
    // Overrides the top-level `temperature` for this entry. A backup is a
    // different model, and some models reject non-default sampling (OpenAI
    // reasoning models accept only their own default), so a pin that fits
    // the primary cannot be assumed to fit the backup.
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

/** One explicitly configured System One fallback (no implicit reuse of primary credentials). */
export const directFallbackSchema = z
  .object({
    provider: directProviderSchema.extend({
      baseUrl: z.url(),
      apiKey: z.string().min(1),
    }),
    model: z.string().min(1),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
  })
  .strict();

/**
 * One backup reviewer in either lane: a registry model (string provider)
 * or an explicitly authenticated System One endpoint (object provider).
 * The provider shape discriminates — no same-lane constraint.
 */
export const fallbackItemSchema = z.union([registryFallbackSchema, directFallbackSchema]);

export type FallbackItem = z.infer<typeof fallbackItemSchema>;

/** One instruction value: text, a JSON object, or an array (SDK EntryType minus null). */
const instructionValueSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.json()),
  z.array(z.json()),
]);

/**
 * The chat lane's slot: `rules` text plus an optional `replace` switch.
 * `replace: true` swaps the built-in safety rules for `rules` instead of
 * appending to them; the verdict contract is never up for replacement, so
 * it stays appended either way.
 */
const chatInstructionSlotSchema = z
  .object({
    rules: z.string().min(1),
    replace: z.boolean().default(false),
  })
  .strict();

/**
 * The classifier lane's slot: shared `background` plus per-question
 * additions. Append-only by design — the built-in reviewer background,
 * questions, and criteria are the answer contract the verdict thresholds
 * are calibrated against, so nothing here replaces them.
 */
const classifierInstructionSlotSchema = z
  .object({
    background: instructionValueSchema.optional(),
    questions: z.record(z.string().min(1), instructionValueSchema).optional(),
  })
  .strict();

/** The classifier slot's parsed shape (derived from its own schema, not re-stated). */
type ClassifierInstructionSlot = z.output<typeof classifierInstructionSlotSchema>;

/**
 * Custom safety rules: a broadcast string (append the same content to every
 * lane) or per-lane slots (`chat` / `classifier`). The object arm is strict,
 * so the forms never blend; empty and shadow slots are rejected by the
 * cross-field checks below.
 */
const instructionsSchema = z
  .union([
    z.string().min(1),
    z
      .object({
        chat: chatInstructionSlotSchema.optional(),
        classifier: classifierInstructionSlotSchema.optional(),
      })
      .strict(),
  ])
  .nullable()
  .default(null);

/** Classifier verdict thresholds — pure policy, no transport knobs. */
const classifierThresholdsSchema = z
  .object({
    intentThreshold: z.number().min(0).max(1).default(0.5),
    riskThreshold: z.number().min(0).max(1).default(0.5),
    confidenceThreshold: z.number().min(0).max(1).default(0.5),
  })
  .strict();

/** Classifier threshold defaults: applied to whichever key the operator wrote (or neither). */
const CLASSIFIER_THRESHOLD_DEFAULTS = classifierThresholdsSchema.parse({});

/**
 * The retired transport knob both threshold blocks still accept: parsed so
 * old files keep loading, never read — the primary timeout is the top-level
 * `timeoutMs` on both lanes. The transform drops it, so no consumer ever sees
 * a field with no effect.
 */
const retiredTimeoutMsSchema = z.number().int().min(1).max(300_000).optional();

/**
 * A classifier threshold block as written. The current `classifier` key and
 * its deprecated alias share this shape; the transform folds the alias into
 * `classifier`.
 */
const classifierBlockSchema = classifierThresholdsSchema.extend({
  timeoutMs: retiredTimeoutMsSchema,
});

/**
 * The deprecated spelling of the `classifier` block: one name for the three
 * sites that fold it (this schema's refine/transform, the loader's per-layer
 * fold, and the save path's leaf removal).
 */
export const CLASSIFIER_ALIAS_KEY = "typesafe";

/**
 * The safe-knob blocks, hoisted so their key sets can be exported (see
 * {@link NESTED_CONFIG_KEYS}): zod strips unknown keys silently, and a typo in
 * one of these names would leave the operator running a default they meant to
 * change.
 */
const transcriptSchema = z.object({
  maxUserMessages: z.number().int().min(1).max(50).default(5),
  maxToolCalls: z.number().int().min(1).max(50).default(10),
  maxCharsPerEntry: z.number().int().min(100).max(20_000).default(1000),
});

const circuitBreakerSchema = z.object({
  consecutive: z.number().int().min(1).max(50).default(3),
  total: z.number().int().min(1).max(200).default(20),
  verdict: z.enum(BREAKER_VERDICT_VALUES).default("deny"),
});

const cacheSchema = z.object({
  maxEntries: z.number().int().min(0).max(1000).default(128),
});

/**
 * The blocks whose inner keys the loader checks, one level deep. The loader
 * reports an unknown key inside them instead of letting zod drop it.
 */
export const NESTED_CONFIG_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["transcript", new Set(Object.keys(transcriptSchema.shape))],
  ["circuitBreaker", new Set(Object.keys(circuitBreakerSchema.shape))],
  ["cache", new Set(Object.keys(cacheSchema.shape))],
]);

const configBaseSchema = z.object({
  model: z.string().min(1),
  reasoning: z.enum(REASONING_VALUES).default("off"),
  timeoutMs: z.number().int().min(1).max(300_000).default(15_000),
  // Reviewer answer budget. For a plain chat model 512 is plenty. With
  // reasoning on the provider families differ: budget-based ones (Anthropic,
  // Bedrock) add the thinking budget on top of this, while effort-based ones
  // (OpenAI-compatible) share this cap with thinking — a too-small cap there
  // truncates the reply mid-think and surfaces as the empty-reply machinery
  // failure. 4096 keeps the stricter, effort-based case safe.
  maxTokens: z.number().int().min(16).max(32768).default(4096),

  // Chat-lane sampling temperature. Unset omits the field, so the provider
  // default applies — what every build before this key did. Set it to 0 to
  // make two reviews of one request agree: the verdict is read straight off
  // the reply, so decode variance surfaces as a flip between runs.
  temperature: z.number().min(0).max(2).optional(),

  // Transcript stripping: how much context to keep for the model review.
  transcript: transcriptSchema
    // Spelled out because zod 4's `.default()` does NOT re-parse the value
    // through the inner schema (only `prefault` does): `.default({})` would
    // reach consumers with every field above undefined.
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

  // Ordered backup reviewers in any lane: registry models (resolved
  // through Pi's registry) or System One endpoints (explicitly
  // authenticated). The provider shape discriminates per item — no
  // same-lane constraint. An empty list preserves single-model behavior.
  fallbacks: fallbackItemSchema.array().max(5).default([]),

  // Classifier verdict thresholds, read on both classifier backends (a
  // registry primary reads them exactly as a direct one does). Both keys
  // stay optional here so "the operator wrote it" is still observable at
  // refine time (a default would always materialize one of them); the
  // legacy-key fold below then fills the winner, and defaults apply to that.
  classifier: classifierBlockSchema.optional(),
  [CLASSIFIER_ALIAS_KEY]: classifierBlockSchema.optional(),

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
  // notify levels plus `off`; the total-tier breaker trip uses `error`.
  // Command feedback is NOT gated.
  notifyLevel: z.enum(NOTIFY_LEVEL_VALUES).default("info"),

  // Opt-in info notices for emitted allows (fresh model and cache hits).
  // Bounded path-family allows are capped to defer by the chain owner and
  // must never be described as approvals.
  notifyApprovals: z.boolean().default(false),

  // Circuit breaker (session-level, fail-safe). `consecutive` is recoverable
  // (resets on trip so the model gets another chance); `total` is a hard
  // session cap (never resets, so once tripped it stays tripped).
  circuitBreaker: circuitBreakerSchema
    // Spelled out for the same zod-4 reason as `transcript` above.
    .default({ consecutive: 3, total: 20, verdict: "deny" }),

  // Verdict cache (session-level LRU). 0 disables; only commands that reach
  // the model (policy "ask") are cached. contextHash from trusted intent
  // invalidates entries when the conversation moves on. Defaults to 128:
  // repeated commands (git status, ls, pnpm test) hit the cache on the second
  // call — zero model cost, zero latency.
  cache: cacheSchema
    // Spelled out for the same zod-4 reason as `transcript` above.
    .default({ maxEntries: 128 }),
});

/**
 * The validated union, before the legacy-key fold (see {@link configSchema}).
 * `reasoning`/`maxTokens` are ignored in classifier mode.
 */
const registryShapeSchema = configBaseSchema.extend({
  provider: z.string().min(1),
  modelType: z.enum(MODEL_TYPE_VALUES).default("chat"),
  instructions: instructionsSchema,
});

const directShapeSchema = configBaseSchema.extend({
  provider: directProviderSchema,
  // Reserved so the contradiction check below can see it: a direct
  // connection never goes through the registry, so any modelType
  // here is rejected, never silently dropped.
  modelType: z.enum(MODEL_TYPE_VALUES).optional(),
  instructions: instructionsSchema,
});

/**
 * Every top-level key a layer may set. The loader reports anything else: zod
 * drops unknown keys silently, and a typo in a safety-relevant name
 * (`surfaces`, `modes`) would leave the operator running the default they meant
 * to change. The deprecated alias is accepted here too — the loader folds and
 * reports it itself.
 */
export const CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(registryShapeSchema.shape),
  ...Object.keys(directShapeSchema.shape),
  CLASSIFIER_ALIAS_KEY,
]);

const configShapeSchema = z
  .union([registryShapeSchema, directShapeSchema])
  .superRefine((config: z.output<typeof configShapeSchema>, ctx) => {
    // modelType is registry addressing — a direct connection ignores it,
    // so its presence means the config doesn't say what the operator
    // thinks it says. Reject loudly (fail-safe), never silently drop.
    if (typeof config.provider === "object" && config.modelType !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["modelType"],
        message:
          "modelType applies to registry (string) providers only; remove it from this direct System One config",
      });
    }
    // The alias key is the deprecated spelling of `classifier`. Both written
    // is a contradiction the operator must resolve — never silently pick one.
    if (config.classifier !== undefined && config[CLASSIFIER_ALIAS_KEY] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [CLASSIFIER_ALIAS_KEY],
        message: `${CLASSIFIER_ALIAS_KEY} is deprecated; remove it and keep only \`classifier\``,
      });
    }
    // Lane slots: a written slot whose lane the pool never runs would
    // silently do nothing — reject, not warn (fail-safe: a config that says
    // what the system won't do must shout). The pool's configured lanes are
    // the primary plus every fallback, so a classifier fallback admits the
    // classifier slot on an otherwise-chat config.
    if (!isObjectRecord(config.instructions)) return;
    const overlay = config.instructions;
    if (overlay.chat === undefined && overlay.classifier === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "empty instructions; set a `chat` and/or `classifier` slot, or use a string",
      });
      return;
    }
    const lanes = configuredLanes(config);
    for (const lane of ["chat", "classifier"] as const) {
      if (overlay[lane] !== undefined && !lanes.includes(lane)) {
        ctx.addIssue({
          code: "custom",
          path: ["instructions", lane],
          message: `no ${lane} reviewer in this pool; a \`${lane}\` slot would never apply`,
        });
      }
    }
    // isObjectRecord widened the union arm to Record<string, unknown>, so the
    // schema-validated slot needs its parsed type back.
    const classifierSlot = overlay.classifier as ClassifierInstructionSlot | undefined;
    if (
      classifierSlot !== undefined &&
      classifierSlot.background === undefined &&
      Object.keys(classifierSlot.questions ?? {}).length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["instructions", "classifier"],
        message: "empty classifier slot; set background and/or questions",
      });
    }
    for (const id of Object.keys(classifierSlot?.questions ?? {})) {
      if (!CLASSIFIER_QUESTION_ID_SET.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["instructions", "classifier", "questions", id],
          message: `unknown question id "${id}"; expected one of ${CLASSIFIER_QUESTION_IDS.join(", ")}`,
        });
      }
    }
  });

/**
 * The lanes a config's reviewer pool contains, judged by
 * {@link isClassifierMode}: the primary plus every fallback. This is the
 * operator's configured composition (a classifier fallback the later
 * admission gate skips can narrow it) — all the lane-slot checks need.
 *
 * @param config - The config (or the pre-fold shape it comes from).
 * @returns The lane names the pool will run, primary first.
 */
function configuredLanes(config: {
  provider: unknown;
  modelType?: unknown;
  fallbacks?: readonly { provider: unknown; modelType?: unknown }[];
}): Array<"chat" | "classifier"> {
  const lanes: Array<"chat" | "classifier"> = [isClassifierMode(config) ? "classifier" : "chat"];
  for (const entry of config.fallbacks ?? []) {
    const lane = isClassifierMode(entry) ? "classifier" : "chat";
    if (!lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}

/**
 * Lane slots an `instructions` object leaves on the built-ins: the pool's
 * lanes minus the ones the object fills. Empty for the string and null
 * forms (which cover / defer to both lanes) and when every lane has a slot.
 * Consumed by the loader's notice — an uncovered lane is not an error, it
 * just runs weaker instructions than the operator may have intended.
 *
 * @param config - The validated config.
 * @returns The uncovered lane names (empty when nothing is left out).
 */
export function uncoveredInstructionLanes(config: AiGuardConfig): Array<"chat" | "classifier"> {
  const overlay = config.instructions;
  if (!isObjectRecord(overlay)) return [];
  return configuredLanes(config).filter((lane) => overlay[lane] === undefined);
}

/** Distributive omit — plain `Omit` on a union collapses it to one member. */
type OmitLegacy<T> = T extends unknown ? Omit<T, typeof CLASSIFIER_ALIAS_KEY> : never;

export const configSchema = configShapeSchema.transform((config): AiGuardConfig => {
  // Fold the deprecated alias into `classifier` and strip the retired
  // `timeoutMs`, so every consumer reads one field with no dead knobs. The
  // alias contributes thresholds only, and blocked defaults fill whichever
  // block was written without them — a config with neither key gets the same
  // values. A single file writing both keys never reaches this transform (the
  // refine rejected it), and the load path folds the alias per layer before
  // merging, so exactly one key arrives here whatever the files said.
  const { [CLASSIFIER_ALIAS_KEY]: alias, ...rest } = config;
  const written = config.classifier ?? alias;
  if (written === undefined) {
    return { ...rest, classifier: CLASSIFIER_THRESHOLD_DEFAULTS };
  }
  const { timeoutMs: _retired, ...thresholds } = written;
  return { ...rest, classifier: thresholds };
});

/**
 * Validated extension configuration (zod schema inference): the legacy
 * `typesafe` key is folded away and `classifier` is required on every member.
 */
export type AiGuardConfig = OmitLegacy<z.output<typeof configShapeSchema>> & {
  classifier: z.output<typeof classifierThresholdsSchema>;
};

/** The config union's direct member (object provider — the classifier engine's config). */
export type DirectProviderConfig = Extract<AiGuardConfig, { provider: DirectProvider }>;

/**
 * Whether the config runs the classifier lane: a direct TypeSafe connection,
 * or a registry string provider with classifier modelType. The pool's
 * lane selection, the instruction-overlay gate, and the lane instruction
 * slicing all consume this — one predicate, not three shape checks.
 *
 * @param config - The validated config (or the pre-fold shape it comes from).
 * @returns True when the primary reviewer is a classifier endpoint.
 */
export function isClassifierMode(config: { provider: unknown; modelType?: unknown }): boolean {
  return isDirectProviderShape(config.provider) || config.modelType === "classifier";
}

/**
 * Whether a provider field carries the direct-connection block rather than a
 * registry id. One shape rule for the two sites that discriminate on it —
 * `isClassifierMode` and the endpoint builder. Presumes a schema-validated
 * config: an object here is the block, never null or an array.
 *
 * @param provider - A config's `provider` field.
 * @returns True for the direct-connection block.
 */
export function isDirectProviderShape(provider: unknown): provider is DirectProvider {
  return typeof provider === "object";
}
