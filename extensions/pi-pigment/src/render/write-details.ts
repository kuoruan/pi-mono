/**
 * The write result-details producer — the one home for turning a write's
 * old/new file state into the `result.details` payload its renderer reads.
 *
 * Two consumers, one shape: the session's `tool_result` channel
 * (write-details-channel.ts) computes it from a pre-read old text and the
 * on-disk result; the renderer's renderer consumes it. Keeping the producer
 * pure and separate means the two can never drift into different
 * `{kind}` dialects.
 *
 * Kept minimal — details persist into the session JSONL, so every field
 * here is one renderResult actually reads.
 */

import { type ParsedDiff, parseDiff } from "#src/core/diff.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

/** The `result.details` shapes a write renderer reads. */
export type WriteResultDetails =
  | {
      /** Discriminator: the file changed, render the diff. */
      kind: "diff";
      /** The parsed old/new diff. */
      diff: ParsedDiff;
      /** The Shiki language for highlighting. */
      language: BundledLanguage | undefined;
    }
  | {
      /** Discriminator: a new file was created, render the content preview. */
      kind: "new";
      /**
       * The file's path (language detection + preview cache key). The
       * content itself is derived from `ctx.args` at render time — it is
       * already persisted once in the call arguments, so details must not
       * duplicate it into the session JSONL.
       */
      filePath: string;
    }
  | {
      /** Discriminator: content identical, render the no-change notice. */
      kind: "noChange";
    };

/**
 * Produce the write details from the file's pre-write state and the
 * content the call wrote.
 *
 * Callers own the self-check: `content` is asserted to be what actually
 * landed on disk before this runs (a stale/mismatched read must drop
 * details, not mislabel a diff), and `oldText` is the file's content
 * before the write (`null` when the file did not exist).
 *
 * @param oldText - The pre-write file content, or null when absent.
 * @param content - The content the write call supplied.
 * @param filePath - The written path (language detection + new-file key).
 * @returns The details payload for the renderer.
 */
export function writeResultDetails(
  oldText: string | null,
  content: string,
  filePath: string,
): WriteResultDetails {
  if (oldText !== null && oldText !== content) {
    return {
      kind: "diff",
      diff: parseDiff(oldText, content, 3),
      language: detectLanguage(filePath),
    };
  }
  if (oldText === null) {
    return { kind: "new", filePath };
  }
  return { kind: "noChange" };
}
