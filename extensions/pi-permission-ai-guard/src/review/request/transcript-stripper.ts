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
  safeStringify,
  textFromContent,
  truncateMiddle,
} from "#src/utils.ts";

import { isBareContinuation } from "./bare-continuation.ts";

export interface StrippedTranscript {
  /**
   * Trusted user messages in chronological order (the most recent N are
   * retained, up to maxUserMessages). Sanitized (zero-width chars
   * stripped, whitespace collapsed) + secrets redacted, so the array is
   * safe to log.
   */
  trustedIntent: string[];
  /**
   * Untrusted tool calls: "toolName: truncatedArgs" (most recent, up to
   * maxToolCalls). Sanitized (zero-width chars stripped, whitespace
   * collapsed) + secrets redacted — same contract as trustedIntent: the
   * stripper is the single sanitization boundary for both arrays.
   */
  toolCalls: string[];
  /** Number of entries that were stripped (for logging) */
  strippedCount: number;
  /**
   * Breakdown of strippedCount, present on stripper output: bare
   * continuations ("go on") and adjacent exact repeats dropped before the
   * quota check. The remaining stripped entries are quota overflows and
   * untrusted content (assistant text, tool results, summaries).
   */
  droppedContinuationCount?: number;
  /** Adjacent exact repeats collapsed before the quota check. */
  droppedRepeatCount?: number;
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
 * `buildContextEntries`; the lifecycle reads `getSessionId` for the
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
  /** Tool-specific structured payload (question tools put the answers here). */
  details?: unknown;
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
 * (host custom entry) and `custom_message` (an equivalent shape)? Neither may
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
 * The pi question tools whose results speak for the human. Exact names only:
 * the catalog is full of near-names that delegate to *another model*
 * (`ask`, `ask_question`, `ask_smarter_model`, `pi-ask-codex`), and trusting
 * one of those would hand the agent's own prose the authorization anchor.
 * pi's own MCP tools (`mcp__<server>__<tool>`) can never collide with these.
 */
const TRUSTED_ASK_TOOLS = new Set(["ask_user_question", "ask_user"]);

/**
 * Check if a tool result came from one of the pi question tools.
 *
 * @param message - The message to check.
 * @returns True if the message is a trusted question tool's result.
 */
function isTrustedAskTool(message: Message): boolean {
  return typeof message.toolName === "string" && TRUSTED_ASK_TOOLS.has(message.toolName);
}

/**
 * Strip a transcript from SessionManager.buildContextEntries().
 * Collects trusted intent (user messages and question-tool answers) and
 * untrusted tool calls, discarding assistant text and every other tool result.
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
  let droppedContinuationCount = 0;
  let droppedRepeatCount = 0;

  // The trusted-intent pipeline: sanitized (injection + secrets) then
  // truncated before it enters the transcript — the ONLY write path, so a
  // change to the pipeline happens in one place. The ORDER is deliberate:
  // redact the full text BEFORE truncating. Reversing it would leak partial
  // credentials — a truncation point landing mid-key leaves a fragment too
  // short for any redaction pattern to match, and the fragment ships to the
  // model raw.
  const pushTrustedIntent = (text: string): void => {
    const sanitized = text
      ? truncateMiddle(normalizeAndRedactText(text), options.maxCharsPerEntry)
      : "";
    // Drop before the quota check: a bare continuation or an adjacent exact
    // repeat carries no new authorization, and either must never evict a real
    // task sentence from the window.
    if (!sanitized) {
      strippedCount++;
      return;
    }
    if (isBareContinuation(sanitized)) {
      strippedCount++;
      droppedContinuationCount++;
      return;
    }
    if (sanitized === trustedIntent[trustedIntent.length - 1]) {
      strippedCount++;
      droppedRepeatCount++;
      return;
    }
    if (trustedIntent.length >= options.maxUserMessages) {
      strippedCount++;
      return;
    }
    trustedIntent.push(sanitized);
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

    const message = entry.message;
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
      // Quota check BEFORE extraction: toolCallsFromAssistant stringifies
      // and redacts every tool-call block (arguments can carry whole files),
      // so once the quota is full, older assistant messages must skip that
      // work entirely — they are counted stripped and dropped, exactly like
      // the other unretained entries.
      if (toolCalls.length >= options.maxToolCalls) {
        strippedCount++;
        continue;
      }
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
      // A question tool's result is the human speaking → attach it as it
      // stands: its structured payload when there is one, else its text. Never
      // re-render or summarize it — the packages disagree on the shape, and
      // anything dropped here is authorization the reviewer cannot see. Every
      // other tool result is untrusted and token-heavy → strip entirely.
      if (isTrustedAskTool(message)) {
        const payload = message.details ?? message.content;
        if (payload === undefined) {
          strippedCount++;
          continue;
        }
        pushTrustedIntent(safeStringify(payload));
      } else {
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

  return { trustedIntent, toolCalls, strippedCount, droppedContinuationCount, droppedRepeatCount };
}
