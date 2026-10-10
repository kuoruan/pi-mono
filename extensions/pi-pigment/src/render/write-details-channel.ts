/**
 * The write details channel: the execution-side hw the write renderer
 * needs but the SDK's write tool does not carry (it stashes
 * `details: undefined`).
 *
 * Pi's extension API has exactly two execution hooks that can carry data
 * from a call to its render: `tool_call` (before execution: read the old
 * file, keyed by `toolCallId`) and `tool_result` (after: recompute and
 * return `{details}`, which the runner merges into the persisted result).
 * `tool_execution_end` is read-only. This channel is that pair, strictly
 * scoped to `toolName === "write"`.
 *
 * Self-check, not blind trust: on `tool_result` the target file is
 * re-read and must byte-equal the content the call supplied. A mismatch
 * (a sibling write landed between our pre-read and the SDK's queued
 * write; another extension rewrote the arguments instead; the write was
 * aborted) drops the details and the renderer falls back to the plain
 * line — a missing preview is always preferable to a lying one. This is
 * also why the channel cannot be a `tool_execution_end` listener: that
 * hook is read-only.
 *
 * Lifecycle: one stash per in-flight `toolCallId`, deleted on its
 * `tool_result` (and on `session_start`/`session_shutdown`, so a call
 * blocked in `tool_call` cannot leak across sessions).
 */

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { createBoundedFifoMap } from "#src/core/bounded-map.ts";

import { currentKit } from "./current-kit.ts";
import { shouldYield } from "./gate.ts";
import { readDecorativeText, resolveToolPath } from "./paths.ts";
import { writeResultDetails } from "./write-details.ts";

/** One in-flight write's pre-read: the old file state and the call's content. */
interface WriteStash {
  /** The display path the call supplied (language detection + new-file key). */
  filePath: string;
  /** The resolved absolute path (the pre-read and the post-write re-read). */
  resolvedPath: string;
  /** The content the call supplied (what the write must have landed). */
  content: string;
  /** The file's pre-write content, or null when it did not exist. */
  oldText: string | null;
}

/**
 * The stashes, keyed by toolCallId. The bound is a memory backstop, not a
 * correctness device: a blocked call (no tool_result ever fires) cannot grow it
 * without limit, and a stash evicted while its call is still in flight simply
 * yields no details — the renderer falls back to the plain line rather than
 * showing a wrong diff. Cleared at every session boundary.
 */
const stashes = createBoundedFifoMap<string, WriteStash>(16);

/** Drop every stash (session boundaries and tests). */
function clearStashes(): void {
  stashes.clear();
}

/**
 * Register the channel's four handlers. Called once at extension load.
 *
 * @param pi - The extension API.
 */
export function registerWriteDetailsChannel(pi: ExtensionAPI): void {
  pi.on("session_start", clearStashes);
  pi.on("session_shutdown", clearStashes);

  pi.on("tool_call", (event: ToolCallEvent) => {
    // The SDK's own guard, not `event.toolName === "write"` + a cast:
    // CustomToolCallEvent.toolName is `string`, so the comparison never
    // narrows (see the guard's own doc) — the cast would silently assume
    // a foreign "write" carries the builtin input shape.
    if (!isToolCallEventType("write", event)) return;
    // Fail-safe, never fail-stop: a throw out of this handler reaches pi's
    // emitToolCall (no guard there) and _beforeToolCall re-frames it as
    // "Extension failed, blocking execution" — a rendering-side fault would
    // stop the model's write from running at all. Swallow it, leave the
    // stash empty, and let the write proceed; the renderer then falls back
    // to the plain line rather than showing no (or a wrong) diff.
    try {
      // Ours to feed: no kit, or the shared yield policy sends the name to
      // pi's own renderers. FFF never claims write, so its signal never fires.
      const kit = currentKit();
      if (kit === undefined) return;
      if (shouldYield("write", kit, pi.getAllTools(), pi.getCommands())) return;
      const input = event.input;
      const filePath = input.path ?? "";
      const content = typeof input.content === "string" ? input.content : "";
      const resolvedPath = resolveToolPath(kit.cwd, filePath);
      stashes.set(event.toolCallId, {
        filePath,
        resolvedPath,
        content,
        oldText: readDecorativeText(resolvedPath) ?? null,
      });
    } catch {
      // Half-written stash, if any: drop it so nothing downstream trusts it.
      stashes.delete(event.toolCallId);
    }
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    if (event.toolName !== "write") return;
    const stash = stashes.get(event.toolCallId);
    stashes.delete(event.toolCallId);
    if (stash === undefined || event.isError) return;
    // The self-check: only claim a diff when what landed IS what the call
    // supplied. A sibling write, a changed argument, or an aborted
    // operation leaves the disk differing → no details → plain fallback.
    const landed = readDecorativeText(stash.resolvedPath);
    if (landed === undefined || landed !== stash.content) return;
    return { details: writeResultDetails(stash.oldText, stash.content, stash.filePath) };
  });
}

/** Clear the stash map (tests only). */
export function resetWriteDetailsChannelForTest(): void {
  clearStashes();
}
