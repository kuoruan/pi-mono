/**
 * The shell failure taxonomy: the exit/signal/timeout/aborted/
 * terminated badge both the error frame (bar color, body ownership) and
 * the shell call header (the "✗ exit N" suffix) compose through. Pure
 * parsing + coloring over explicit inputs — no module state beyond the
 * benign-exit list.
 */

import type { RenderTheme } from "#src/theme/scheme.ts";

import { type StateColor } from "./tool-output.ts";

/**
 * The shell failure badge: the failure kind + the exit code
 * (error/signal) or timeout seconds (timeout); 0 for the code-less
 * kinds (aborted/terminated).
 */
export interface ShellExitBadge {
  /** The failure kind. */
  kind: "error" | "signal" | "timeout" | "aborted" | "terminated";
  /** The measured value (see above). */
  value: number;
}

/**
 * UPSTREAM CONTRACT MIRROR — the pi SDK's bash/powershell failure path
 * (dist/core/tools/bash.js, `appendStatus`): a failed command THROWS, and
 * the agent loop reduces the throw to `createErrorToolResult(message)` —
 * the exit code survives only inside the message text, as one of four
 * appended status lines:
 *
 * "Command exited with code ${exitCode}"
 * "Command timed out after ${timeoutSecs} seconds"
 * "Command aborted"
 * "Command terminated without an exit code"
 *
 * These patterns mirror those exact strings. A miss degrades to an
 * unbadged frame — never a broken one — so an upstream reword costs the
 * badge, nothing else.
 */
const EXIT_CODE_RE = /Command exited with code (\d+)$/;
const TIMEOUT_RE = /Command timed out after (\d+) seconds$/;
const ABORTED_SUFFIX = "Command aborted";
const TERMINATED_SUFFIX = "Command terminated without an exit code";

/**
 * Parse the shell failure status from an error message's tail.
 *
 * @param message - The tool error message (the SDK appends the status).
 * @returns The badge, or undefined when the tail carries no known status
 *   (a non-shell error, or an upstream message-format change — the frame
 *   then renders without a badge, degraded never broken).
 */
/**
 * Whether the tool is a shell tool (badge parsing applies). One home —
 * the taxonomy owns the membership, not each call site.
 *
 * @param name - The tool's name.
 * @returns True for bash/powershell.
 */
export function isShellTool(name: string): boolean {
  return name === "bash" || name === "powershell";
}

export function shellExitBadgeOf(message: string): ShellExitBadge | undefined {
  const exit = message.match(EXIT_CODE_RE);
  if (exit) {
    const code = Number(exit[1]);
    return code >= 128 && code <= 255
      ? { kind: "signal", value: code }
      : { kind: "error", value: code };
  }
  const timeout = message.match(TIMEOUT_RE);
  if (timeout) return { kind: "timeout", value: Number(timeout[1]) };
  if (message.endsWith(ABORTED_SUFFIX)) return { kind: "aborted", value: 0 };
  if (message.endsWith(TERMINATED_SUFFIX)) return { kind: "terminated", value: 0 };
  return undefined;
}

/**
 * The badge suffix's failure-kind color: plain non-zero exits error,
 * no-match exit 1 dims to muted (needs the command), everything else warns.
 *
 * @param badge - The parsed status.
 * @param command - The shell command text (used to determine benign exits).
 * @returns The theme color name.
 */
export function shellBadgeColorOf(badge: ShellExitBadge, command?: string): StateColor {
  if (badge.kind !== "error") return "warning";
  return isBenignExit(command, badge) ? "muted" : "error";
}

/**
 * The badge's plain text — one WORDED form per failure kind ("✗ exit 1",
 * "✗ exit 143", "✗ timeout 30s", "✗ aborted", "✗ terminated"): the bare
 * "✗ 1" form it replaces read as a cryptic glyph + number; the verb tells
 * what the code measures. The signal band shares the exit form — its
 * distinct warning color is the band's signal, and 143 IS the exit code.
 *
 * @param badge - The parsed status.
 * @returns The unstyled badge text.
 */
function shellBadgeLabel(badge: ShellExitBadge): string {
  switch (badge.kind) {
    case "timeout":
      return `✗ timeout ${badge.value}s`;
    case "aborted":
      return "✗ aborted";
    case "terminated":
      return "✗ terminated";
    case "signal":
    case "error":
      return `✗ exit ${badge.value}`;
  }
}

/**
 * Commands whose exit 1 means "nothing found", not failure: grep-family
 * no-match, test-family false condition, diff-family no-difference.
 * Matched against the command's first word (and `git diff --quiet`'s
 * first two); compound commands (pipes, &&, ;) never qualify.
 *
 * @param command - The shell command text (undefined = unknown, not benign).
 * @param badge - The parsed status (only error-kind exit 1 qualifies).
 * @returns True when exit 1 is a benign no-match result.
 */
export function isBenignExit(command: string | undefined, badge: ShellExitBadge): boolean {
  if (badge.kind !== "error" || badge.value !== 1 || !command) return false;
  // Compound commands never qualify (fail-closed): only a lone SimpleCommand
  // gets the dim treatment.
  if (/[|&;\n]/.test(command.replace(/'[^']*'|"[^"]*"/g, ""))) return false;
  // Five tokens cover git's flag shuffles (diff --cached --stat --quiet);
  // beyond that a miss stays red (fail-closed).
  const head = command.trimStart().split(/\s+/, 5);
  // --quiet is a flag (position-free); grep shares grep's no-match semantics.
  if (head[0] === "git" && (head.includes("--quiet") || head[1] === "grep")) return true;
  return BENIGN_EXIT_COMMANDS.has(head[0] ?? "");
}

/** Benign-exit command heads: exit 1 is "nothing found", not failure. */
const BENIGN_EXIT_COMMANDS = new Set([
  "grep",
  "rg",
  "ack",
  "test",
  "[",
  "[[",
  "diff",
  "cmp",
  "Select-String",
]);

/**
 * The badge's styled form — the worded label, bold, in the kind's color.
 * Pass the command for benign-exit dimming (exit 1 that means no-match
 * renders muted, text unchanged).
 *
 * @param badge - The parsed status.
 * @param theme - The pi theme (colors).
 * @param command - The shell command text (optional, enables dimming).
 * @returns The styled badge text (no leading separator — the call site
 *   composes the muted `·` + spaces around it).
 */
export function shellBadgeText(
  badge: ShellExitBadge,
  theme: RenderTheme,
  command?: string,
): string {
  return theme.fg(shellBadgeColorOf(badge, command), theme.bold(shellBadgeLabel(badge)));
}
