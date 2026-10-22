import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";

import { isObjectRecord } from "#src/utils.ts";

import { SUSPICION_ORDER } from "./suspicion.ts";

export const EXTENSION_ID = "pi-permission-ai-guard";
export const LINK_NAME = "ai-guard";

/**
 * How the link disposes the reviewer's non-allow verdicts — the leniency
 * ladder, strictest first. Only the deterministic screen hard-denies; a
 * model deny is always soft, whatever `riskLevel` it reports — that field is
 * an audit label and never picks the tier. The mode maps the model's deny
 * and its own uncertainty against the ladder. The ctrl+alt+g cycle visits
 * `default` and `auto`; only `strict` is set explicitly (`/ai-guard mode
 * strict`).
 */
export const BUILTIN_MODE_VALUES = ["strict", "default", "auto"] as const;

/** A built-in mode: a row of the ladder table (`MODE_TABLE`). */
export type BuiltinMode = (typeof BUILTIN_MODE_VALUES)[number];

/**
 * How the link disposes the reviewer's non-allow verdicts — a built-in
 * ladder rung, or `custom` for the operator-defined cuts in `customMode`.
 * `custom` is only selectable while `customMode` configures legal cuts;
 * the resolver (`mode-policy.ts`) enforces that after parsing.
 */
export const MODE_VALUES = [...BUILTIN_MODE_VALUES, "custom"] as const;

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
 * The axis question ids — a config-level contract. The schema validates
 * instruction overlays against this list, and the request builder keys its
 * questions by it (via the question registry in questions.ts), so both sides
 * share the one source and a new axis is one entry, not two lists that can
 * drift. Order matches the registry: the ban wall, the effect, the target,
 * then the intent.
 */
export const CLASSIFIER_QUESTION_IDS = ["ban", "effect", "target", "intent"] as const;

/**
 * Membership check for the overlay ids (string-keyed: config keys are strings). Exported for the
 * offline A/B harness's variant validation.
 */
export const CLASSIFIER_QUESTION_ID_SET: ReadonlySet<string> = new Set(CLASSIFIER_QUESTION_IDS);

/** One of the System One question ids. */
export type ClassifierQuestionId = (typeof CLASSIFIER_QUESTION_IDS)[number];

/**
 * How the registry provider resolves the model — pi's model-type
 * vocabulary (`ModelType`). Absent means chat; `classifier` selects pi's
 * built-in classifier models via `modelRegistry.classify`. Closed set: the
 * enum is this extension's honest capability surface.
 */
export const MODEL_TYPE_VALUES = ["chat", "classifier"] as const;

/**
 * The reviewer timeout, stated once for the primary and every backup entry.
 * One millisecond to five minutes.
 */
const timeoutMsSchema = z.number().int().min(1).max(300_000);

/** Chat-lane sampling temperature; a backup entry pins it the same way. */
const temperatureSchema = z.number().min(0).max(2);

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
    timeoutMs: timeoutMsSchema.optional(),
    // Overrides the top-level `temperature` for this entry. A backup is a
    // different model, and some models reject non-default sampling (OpenAI
    // reasoning models accept only their own default), so a pin that fits
    // the primary cannot be assumed to fit the backup.
    temperature: temperatureSchema.optional(),
  })
  .strict();

/** One backup reviewer: a registry model (chat by default, or a classifier). */
export type FallbackItem = z.infer<typeof registryFallbackSchema>;

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

/**
 * Classifier verdict thresholds — pure policy, no transport knobs. The five
 * axis questions leave one threshold: the minimum confidence at which a
 * classifier reading is adopted (0–1, default 0.5, retained from the
 * retired protocol rather than recalibrated). Below it that axis takes its
 * uncertainty path. The threshold compares pi-ai's returned `confidence` —
 * the label distribution's peak concentration — which is NOT an
 * evidence-coverage measure; `unestablished` and the explicit evidence-
 * missing paths stay a separate mechanism.
 */
const classifierThresholdsSchema = z
  .object({
    confidenceThreshold: z.number().min(0).max(1).default(0.5),
  })
  .strict();

/** The classifier threshold defaults, computed once from the schema itself. */
const CLASSIFIER_THRESHOLD_DEFAULTS = classifierThresholdsSchema.parse({});

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

/**
 * How a custom mode disposes a reviewer allow that met a proven-irreversible
 * effect (the deterministic floor). One knob, not a pair: the axis has no
 * order to cut, only an outcome to choose.
 */
export const IRREVERSIBLE_RULING_VALUES = ["allow", "defer", "deny"] as const;

/** One outcome on the irreversible axis (see {@link IRREVERSIBLE_RULING_VALUES}). */
export type IrreversibleRuling = (typeof IRREVERSIBLE_RULING_VALUES)[number];

/**
 * The operator-defined ladder row: two cut lines on `SUSPICION_ORDER`, the
 * reviewer-failure lane, and the irreversible axis. There are no per-rung
 * cells, so a custom row is contiguous by construction — the same shape the
 * built-in rows have. A pair whose accept line touches or passes its reject
 * line is legal (it has no ask band); the resolver decides whether the result
 * is worth a warning.
 *
 * `onIrreversibleEffect` is a second axis rather than a rung on the suspicion
 * line: "the reviewer doubted" and "the facts proved this unrecoverable" are
 * different questions, and a doubt scale cannot measure irreversibility. Its
 * default is what every built-in rung does, so an existing `customMode` block
 * keeps its behaviour without migration.
 */
const customModeSchema = z.object({
  allowThrough: z.enum(SUSPICION_ORDER),
  denyFrom: z.enum(SUSPICION_ORDER),
  onReviewFailure: z.enum(["deny", "defer"]),
  onIrreversibleEffect: z.enum(IRREVERSIBLE_RULING_VALUES).default("defer"),
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
  ["customMode", new Set(Object.keys(customModeSchema.shape))],
]);

const configBaseSchema = z.object({
  model: z.string().min(1),
  reasoning: z.enum(REASONING_VALUES).default("off"),
  timeoutMs: timeoutMsSchema.default(15_000),
  // Reviewer answer budget. For a plain chat model 512 is plenty. With
  // reasoning on the provider families differ: budget-based ones (Anthropic,
  // Bedrock) add the thinking budget on top of this, while effort-based ones
  // (OpenAI-compatible) share this cap with thinking — a too-small cap there
  // truncates the reply mid-think and surfaces as the empty-reply machinery
  // failure. 4096 keeps the stricter, effort-based case safe.
  maxTokens: z.number().int().min(16).max(32768).default(4096),

  // Sampling temperature for both lanes. Unset omits the field, so the
  // provider default applies — what every build before this key did. Set
  // it to 0 to make two reviews of one request agree: the verdict is read
  // straight off the reply, so decode variance surfaces as a flip between
  // runs. Backends without a sampling knob ignore it (TypeSafe carries
  // none); llama-cpp scales the label softmax with it.
  temperature: temperatureSchema.optional(),

  // Transcript stripping: how much context to keep for the model review.
  transcript: transcriptSchema
    // `prefault` runs the empty object through the inner schema, so the
    // defaults above stay the only place those numbers are written. (zod 4's
    // `.default()` does not re-parse — `.default({})` would reach consumers
    // with every field undefined.)
    .prefault({}),

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

  // Ordered backup reviewers in any lane: registry models, chat or
  // classifier, resolved through Pi's registry. An empty list preserves
  // single-model behavior.
  fallbacks: registryFallbackSchema.array().max(5).default([]),

  // Classifier verdict thresholds; an absent block reads as the defaults.
  classifier: classifierThresholdsSchema.default(CLASSIFIER_THRESHOLD_DEFAULTS),

  // How the link disposes the reviewer's non-allow verdicts (the leniency
  // ladder, strictest first): `"custom"` runs the `customMode` row instead
  // of a built-in one (see that field). Two cut lines on `SUSPICION_ORDER`,
  // per-mode blurbs in `MODE_BLURBS`, reviewer-failure targets in each
  // mode's `onReviewFailure`. The per-mode rows live in `README.md`'s mode
  // table, the one operator-facing authority — this comment only points
  // at it.
  mode: z.enum(MODE_VALUES).default("default"),

  // The custom row's cut lines, read only when `mode` is "custom"; null
  // means "not configured". The resolver validates the pair after parsing and
  // falls back to `default` when `mode: "custom"` has nothing to resolve.
  customMode: customModeSchema.nullable().default(null),

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
    // `prefault`, for the same zod-4 reason as `transcript` above.
    .prefault({}),

  // Verdict cache (session-level LRU). 0 disables; only commands that reach
  // the model (policy "ask") are cached. contextHash from trusted intent
  // invalidates entries when the conversation moves on. Defaults to 128:
  // repeated commands (git status, ls, pnpm test) hit the cache on the second
  // call — zero model cost, zero latency.
  cache: cacheSchema
    // `prefault`, for the same zod-4 reason as `transcript` above.
    .prefault({}),
});

/** The config shape itself. `reasoning`/`maxTokens` are ignored in classifier mode. */
const registryShapeSchema = configBaseSchema.extend({
  provider: z.string().min(1),
  modelType: z.enum(MODEL_TYPE_VALUES).default("chat"),
  instructions: instructionsSchema,
});

/**
 * Every top-level key a layer may set. The loader reports anything else: zod
 * drops unknown keys silently, and a typo in a safety-relevant name
 * (`surfaces`, `modes`) would leave the operator running the default they meant
 * to change.
 */
export const CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(registryShapeSchema.shape),
);

export const configSchema = registryShapeSchema.superRefine(
  (config: z.output<typeof registryShapeSchema>, ctx) => {
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
  },
);

/**
 * The lanes a config's reviewer pool contains, judged by
 * {@link isClassifierMode}: the primary plus every fallback. This is the
 * operator's configured composition (a classifier fallback the later
 * admission gate skips can narrow it) — all the lane-slot checks need.
 *
 * @param config - The validated config.
 * @returns The lane names the pool will run, primary first.
 */
/** The fields the lane composition reads: the primary entry plus each fallback entry. */
interface ReviewerPoolShape {
  readonly provider: unknown;
  readonly modelType?: unknown;
  readonly fallbacks?: readonly { readonly provider: unknown; readonly modelType?: unknown }[];
}

function configuredLanes(config: ReviewerPoolShape): Array<"chat" | "classifier"> {
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

/** Validated extension configuration (zod schema inference). */
export type AiGuardConfig = z.output<typeof configSchema>;

/** The one field the lane decision reads, so a partial entry can be judged. */
interface ModelTypeCarrier {
  readonly modelType?: unknown;
}

/**
 * Whether the config runs the classifier lane: a registry string provider
 * with classifier modelType. The pool's lane selection, the
 * instruction-overlay gate, and the lane instruction slicing all consume
 * this — one predicate, not three shape checks.
 *
 * @param config - The validated config, or one fallback entry.
 * @returns True when the primary reviewer is a classifier endpoint.
 */
export function isClassifierMode(config: ModelTypeCarrier): boolean {
  return config.modelType === "classifier";
}
