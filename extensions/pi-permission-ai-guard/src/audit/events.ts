/**
 * The audit-log event names — the log's read contract. Readers
 * (decision-log-reader) and writers (pipeline gates, engines) share these
 * so neither side redeclares the strings.
 */
export const DECISION_EVENT = "ai_guard.decision";

export const SHORT_CIRCUIT_EVENT = "ai_guard.short_circuit";

export const MODEL_REPLY_EVENT = "ai_guard.model_reply";

export const CACHE_LOOKUP_EVENT = "ai_guard.cache_lookup";

export const MODEL_CALL_ERROR_EVENT = "ai_guard.model_call_error";

export const COVERAGE_EVENT = "ai_guard.coverage";
