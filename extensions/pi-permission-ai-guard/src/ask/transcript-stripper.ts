/**
 * Transcript stripper: builds a token-optimized transcript by
 * stripping (not truncating) assistant text and tool results.
 *
 * - Assistant text is untrusted and token-heavy → delete
 * - Tool results are untrusted (injection entry point) and token-heaviest → delete
 * - User messages are trusted authorization signals → keep
 * - Tool call names + args show what the agent did → keep (truncated)
 * - Ask_user_question results are trusted (user's structured answers) → keep
 * - Compaction summaries are derived context, not user authorization → delete
 */

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import {
  isObjectRecord,
  normalizeAndRedactText,
  textFromContent,
  truncateMiddle,
} from "#src/utils.ts";

export interface StrippedTranscript {
  /**
   * Trusted user messages in chronological order (the most recent N are
   * retained, up to maxUserMessages). Sanitized (zero-width chars
   * stripped, whitespace collapsed) + secrets redacted, so the array is
   * safe to log.
   */
  trustedIntent: string[];
  /** Untrusted tool calls: "toolName: truncatedArgs" (most recent, up to maxToolCalls) */
  toolCalls: string[];
  /** Number of entries that were stripped (for logging) */
  strippedCount: number;
}

/** Options for transcript stripping. */
export interface StripOptions {
  /** Max trusted user messages to keep (most recent). */
  maxUserMessages: number;
  /** Max tool calls to keep (most recent). */
  maxToolCalls: number;
  /** Max characters per entry (truncated head+tail). */
  maxCharsPerEntry: number;
}

/**
 * Minimal projection of the host's SessionManager shared by the stripper
 * and the session lifecycle — derived (not hand-written) so the signature
 * can't drift from the real manager: the stripper needs
 * `buildContextEntries`; the lifecycle reads `getSessionId` for the v27
 * session-keyed permissions service.
 */
export type SessionManagerLike = Pick<SessionManager, "buildContextEntries" | "getSessionId">;

/** Structural projection of a session message entry. */
type Message = {
  /** Role: "user", "assistant", or "toolResult". */
  role?: string;
  /** Message content (string or array of blocks). */
  content?: unknown;
  /** Tool name (set on toolResult entries). */
  toolName?: string;
};

/**
 * Type guard: is this entry a message entry?
 *
 * @param entry - The session entry to test.
 * @returns True if `entry` is a message entry (type-narrowed accordingly).
 */
function isMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
  return entry.type === "message";
}

/**
 * Type guard: is this entry one of the two custom entry kinds — `custom`
 * (host custom entry) and `custom_message` (the newer shape)? Neither may
 * become an authorization signal.
 *
 * @param entry - The session entry to test.
 * @returns True if `entry` has either custom type (type-narrowed accordingly).
 */
function isCustomEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" | "custom_message" }> {
  return entry.type === "custom" || entry.type === "custom_message";
}

/**
 * Type guard: does this entry have a summary field? (compaction or branch_summary)
 *
 * @param entry - The session entry to test.
 * @returns True if `entry` has a `summary` field (type-narrowed accordingly).
 */
function hasSummary(entry: SessionEntry): entry is Extract<SessionEntry, { summary: string }> {
  return entry.type === "compaction" || entry.type === "branch_summary";
}

/**
 * Extract tool calls from an assistant message's content array.
 * Returns ["toolName: truncatedArgs", ...]
 *
 * Sanitizes args to mitigate prompt injection: strips control characters
 * (newlines, carriage returns) so multi-line injection payloads collapse
 * to a single line, and truncates to limit payload size.
 *
 * @param content - The assistant message's content array.
 * @param maxChars - Maximum characters per tool-call argument string.
 * @returns An array of `"toolName: truncatedArgs"` strings.
 */
function toolCallsFromAssistant(content: unknown, maxChars: number): string[] {
  if (!Array.isArray(content)) return [];
  const calls: string[] = [];
  for (const block of content) {
    if (!isObjectRecord(block)) continue;
    if (block.type !== "toolCall") continue;
    const name =
      typeof block.name === "string"
        ? block.name
        : typeof block.toolName === "string"
          ? block.toolName
          : "unknown";
    let argStr: string;
    try {
      argStr =
        typeof block.arguments === "string"
          ? block.arguments
          : JSON.stringify(block.arguments ?? {});
    } catch {
      argStr = String(block.arguments);
    }
    // Sanitize: strip zero-width chars + collapse whitespace to prevent injection
    const normalized = normalizeAndRedactText(argStr);
    calls.push(`${name}: ${truncateMiddle(normalized, maxChars)}`);
  }
  return calls;
}

/**
 * Check if a user message is an ask_user_question tool result
 * (contains the user's structured answers — trusted intent).
 *
 * @param message - The message to check.
 * @returns True if the message is an ask_user_question tool result.
 */
function isAskUserQuestionResult(message: Message): boolean {
  return message.toolName === "ask_user_question";
}

/**
 * Strip a transcript from SessionManager.buildContextEntries().
 * Collects trusted intent (user messages) and untrusted tool calls,
 * discarding assistant text and tool results entirely.
 *
 * Uses `buildContextEntries()` so pi applies compaction path handling
 * (omitting pre-compaction summarized entries, representing the latest
 * compaction/branch_summary by their own entries).
 *
 * @param sessionManager - The session manager to read entries from.
 * @param options - Stripping limits (max user messages, tool calls, chars per entry).
 * @returns A `StrippedTranscript` with trusted intent, tool calls, and the stripped count.
 */
export function stripTranscript(
  sessionManager: SessionManagerLike,
  options: StripOptions,
): StrippedTranscript {
  const entries = sessionManager.buildContextEntries();
  const trustedIntent: string[] = [];
  const toolCalls: string[] = [];
  let strippedCount = 0;

  // The trusted-intent pipeline: sanitized (injection + secrets) then
  // truncated before it enters the transcript — the ONLY write path, so a
  // change to the pipeline happens in one place.
  const pushTrustedIntent = (text: string): void => {
    if (text && trustedIntent.length < options.maxUserMessages) {
      trustedIntent.push(truncateMiddle(normalizeAndRedactText(text), options.maxCharsPerEntry));
    }
  };

  // Walk entries in reverse (most recent first) to prioritize recent context
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;

    if (hasSummary(entry)) {
      // A summary is not a verbatim user message and may include model or tool
      // content. It must never become an authorization signal.
      strippedCount++;
      continue;
    }

    if (isCustomEntry(entry)) {
      strippedCount++;
      continue;
    }

    if (!isMessageEntry(entry)) {
      strippedCount++;
      continue;
    }

    const message = entry.message as Message | undefined;
    if (!message || !message.role) {
      strippedCount++;
      continue;
    }

    const role = message.role;

    if (role === "user") {
      // UserMessage carries no toolName (ask_user_question answers arrive as
      // toolResult entries, handled below), so every user message is plain
      // trusted intent.
      pushTrustedIntent(textFromContent(message.content));
      continue;
    }

    if (role === "assistant") {
      // Extract tool calls only, discard assistant text
      const calls = toolCallsFromAssistant(message.content, options.maxCharsPerEntry);
      for (const call of calls) {
        if (toolCalls.length < options.maxToolCalls) {
          toolCalls.push(call);
        }
      }
      // If assistant had text but no tool calls, count as stripped
      if (calls.length === 0) {
        const text = textFromContent(message.content);
        if (text) strippedCount++;
      }
      continue;
    }

    if (role === "toolResult") {
      // ask_user_question results are trusted (user's structured answers)
      if (isAskUserQuestionResult(message)) {
        pushTrustedIntent(textFromContent(message.content));
      } else {
        // Other tool results are untrusted and token-heavy → strip entirely
        strippedCount++;
      }
      continue;
    }

    // Unknown role → strip
    strippedCount++;
  }

  // Reverse to chronological order
  trustedIntent.reverse();
  toolCalls.reverse();

  return { trustedIntent, toolCalls, strippedCount };
}
