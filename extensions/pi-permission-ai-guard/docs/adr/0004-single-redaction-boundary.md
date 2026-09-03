# 4. The stripper is the single sanitization boundary for transcript entries

Date: 2026-09-03

## Status

Accepted (advisor-reviewed adjudication; supersedes the prompt layer's implicit second pass)

## Context

The review prompt renders trusted-intent and tool-call entries from the `StrippedTranscript`. Until this decision, the prompt layer re-ran `normalizeAndRedactText` over every entry it rendered — 15 entries × 21 regex scans per model call, duplicating work the stripper (`pushTrustedIntent` / `toolCallsFromAssistant`) had already done under the type's documented contract ("Sanitized … + secrets redacted").

The duplication had already caused test drift: the prompt's injection test fed a multi-line trusted-intent entry — a state the stripper's flattening contract rules out. The tests were pinning prompt behavior on inputs the system cannot produce.

## Decision

The stripper is the single sanitization boundary; the prompt renders entries verbatim.

Defense in depth was weighed and rejected as misapplied here: depth requires mechanisms with independent failure modes, and this was the same pure function run twice. The only failure the second pass uniquely covered — "the stripper didn't run" — is pinned by the stripper's own tests (real secrets fed through `stripTranscript`, `[REDACTED]` asserted); pattern gaps and order bugs pass through both layers identically, so repetition adds no coverage there. The prompt is also the only consumer of entry text, so the two layers were one pipeline with two claimed owners of the same concern.

## Consequences

- The `StrippedTranscript` field docs are the contract: any future write path into either array must sanitize (zero-width strip, whitespace collapse, secret redaction) before pushing; the prompt and any later consumer render entries verbatim and must not re-redact.
- Depth moved to the test suite: a composed end-to-end test (stripper output fed directly into `buildReviewPrompt`) pins redaction, flattening, and the tool-call-argument path as one chain. Any drift on either side — a new write path that skips sanitization, a sanitize/truncate reorder, a prompt-side refactor — turns it red.
- The same ruling applies to the defer raw reply (redacted once in the pipeline; the debug event and the decision record share the result) and to model reasons (redacted once at verdict parse, `normalizeReason`).
- The stripper's redact-before-truncate order is deliberate and load-bearing: truncating first would leak partial credentials (a cut point landing mid-key leaves a fragment too short for any redaction pattern to match). Do not "optimize" the order.

Do not re-add per-layer re-redaction without revisiting this decision.
