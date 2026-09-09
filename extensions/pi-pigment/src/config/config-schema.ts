import { z } from "zod";

import { isOpaqueHex6 } from "#src/core/color.ts";
import { isRootHex, type DiffRoots } from "#src/theme/palette.ts";
import { SEMANTIC_KEYS, type SemanticColors } from "#src/theme/syntax-theme.ts";

/** The directory name the extension's themes/ and config live under (`extensions/<this>`). */
export const CONFIG_HOME = "pigment";

/** The built-in tools pi-pigment can wrap. */
const TOOL_NAMES = ["write", "edit", "bash", "powershell", "grep", "ls", "find"] as const;
/** A wrappable built-in tool. */
export type ToolName = (typeof TOOL_NAMES)[number];

/** The valid indicatorStyle config values. */
const INDICATOR_STYLE_VALUES = ["bar", "none"] as const;

/** Left-edge change-indicator style. */
export type IndicatorStyle = (typeof INDICATOR_STYLE_VALUES)[number];

/** Semantic syntax color patches: only listed keys deviate (opaque #rrggbb only). */
const semanticColorsSchema = z.partialRecord(
  z.enum(SEMANTIC_KEYS),
  z.string().refine(isOpaqueHex6, { message: "must be an opaque #rrggbb color" }),
);

/** One side's root slots (mirrors the DiffRootSide interface). */
const diffRootSideSchema = z
  .object({
    text: z
      .string()
      .refine((v) => isRootHex("text", v), {
        message: "must be an opaque #rrggbb (or #rgb) color",
      })
      .optional(),
    tint: z
      .string()
      .refine((v) => isRootHex("tint", v), {
        message: "must be a #rrggbbaa (or #rgba) tint",
      })
      .optional(),
  })
  .strict();

/**
 * Diff-root overrides, nested per side (pi's toolDiffAdded/toolDiffRemoved
 * vocabulary): the shape itself carries which sides and slots exist, and
 * isRootHex is the single home of what each slot accepts — the key IS the
 * semantics: `text` takes the opaque forms (6-digit, or `#rgb`), `tint`
 * takes the alpha-carrying forms (8-digit, or `#rgba`); a misplaced form
 * fails at load with an issue, never silently at render. The box canvas
 * is NOT a root (ADR 0006): it is the pi theme's own `toolSuccessBg`,
 * overridable only by picking another theme.
 */
const diffRootsSchema = z
  .object({
    added: diffRootSideSchema.optional(),
    removed: diffRootSideSchema.optional(),
  })
  .strict();

/** One polarity variant of a theme object: a base and/or patches/roots. */
const themeVariantSchema = z
  .object({
    /**
     * The theme this polarity uses (a theme name or a "light/dark" pair); absent inherits the
     * object's base.
     */
    base: z.string().optional(),
    /** Semantic syntax colors for this polarity. */
    colors: semanticColorsSchema.optional(),
    /** Diff roots for this polarity. */
    diff: diffRootsSchema.optional(),
  })
  .refine(
    (variant) =>
      variant.base !== undefined || variant.colors !== undefined || variant.diff !== undefined,
    {
      message: "a variant must set base, colors, or diff",
    },
  );

/** One polarity variant of a theme object (validated form). */
export type ThemeVariant = { base?: string; colors?: SemanticColors; diff?: DiffRoots };

/** The inline `syntaxTheme` object (ADR 0002): patch mode or variant mode. */
const themeObjectSchema = z
  .object({
    /** The theme being patched; absent means variant mode (variants define it). */
    base: z.string().optional(),
    /** Semantic syntax colors patching both polarities. */
    colors: semanticColorsSchema.optional(),
    /** Diff roots shared by both polarities. */
    diff: diffRootsSchema.optional(),
    /** The light variant. */
    light: themeVariantSchema.optional(),
    /** The dark variant. */
    dark: themeVariantSchema.optional(),
  })
  .strict()
  .refine(
    (obj) =>
      obj.base !== undefined ||
      obj.light?.base !== undefined ||
      obj.light?.colors !== undefined ||
      obj.dark?.base !== undefined ||
      obj.dark?.colors !== undefined,
    {
      message:
        'a syntaxTheme object needs a "base" (patch mode) or a variant with "base"/"colors" (variant mode) — add "base": "auto" for diff-only overrides',
    },
  );

/** The inline `syntaxTheme` object (validated form). */
export type ThemeObject = {
  /** The base ("auto", a theme name, or a "light/dark" pair) — patch mode when set. */
  base?: string;
  /** Direct semantic overrides (patch mode). */
  colors?: SemanticColors;
  /** Direct diff-root overrides (patch mode). */
  diff?: DiffRoots;
  /** The light variant (variant mode). */
  light?: ThemeVariant;
  /** The dark variant (variant mode). */
  dark?: ThemeVariant;
};

/**
 * The `syntaxTheme` config value: a string ("auto", a theme name, or a
 * "light/dark" slash pair) or an inline theme object. String resolution
 * happens in theme-resolver.ts (slash pair → name resolution →
 * issue + auto).
 */
const syntaxThemeSchema = z.union([z.string(), themeObjectSchema]);

/**
 * The entire configuration surface (ADR 0001/0002): which tools get the diff
 * wrapper, the left-edge change-indicator style, and the syntax theme
 * (string or theme object). Everything else the renderer does is fixed
 * behavior derived from the active pi theme.
 */
export const configSchema = z
  .object({
    /** Tools pi-pigment does NOT register; Pi's built-in tool is used instead. */
    disabledTools: z.array(z.enum(TOOL_NAMES)).default([]),
    /** Left-edge change indicator: the bar marker, or none. */
    indicatorStyle: z.enum(INDICATOR_STYLE_VALUES).default("bar"),
    /** The syntax theme selection: a name string or an inline theme object. */
    syntaxTheme: syntaxThemeSchema.default("auto"),
  })
  // Strict (diffRootsSchema's precedent): a mistyped key like
  // `disabledTool` silently doing nothing is worse than a recorded issue.
  .strict();

/** Validated extension configuration (zod schema inference). */
export type PigmentConfig = z.infer<typeof configSchema>;
