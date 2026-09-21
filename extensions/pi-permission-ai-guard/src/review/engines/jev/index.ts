/**
 * Jev reviewer: the TypeSafe System One backend behind the ReviewerEngine seam.
 *
 * Calibrated questions ported from SAFETY_RULES; answers are probabilities,
 * never text, so deny reasons synthesize from the danger category and low
 * confidence defers like the LLM lean.
 *
 * External consumers use the engine factory (question ids live on the
 * config schema, which validates overlays against them). Everything else
 * is internal; tests import the deep modules directly.
 */

export { createJevEngine } from "./engine.ts";
