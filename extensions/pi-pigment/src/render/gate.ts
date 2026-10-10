/**
 * The renderer yield gates — the presence checks that decide whether
 * pi-pigment may decorate a built-in tool name, plus the one ordered
 * policy (`shouldYield`) that combines them:
 *
 * - `claimedByOther`: a name another extension (or an SDK-passed custom tool) already owns. pi merges
 *   by extension load order, so a later same-name registration from us would shadow the neighbor's
 *   tool; yielding is the documented default.
 * - `fffPresent`: the pi-fff compatibility signal, kept as an order-safe fast path (FFF's `/fff-mode`
 *   command registers at module load, before any `session_start`).
 * - `shouldYield`: the ordered decision (ADR 0005) both the resolver and the write-details channel
 *   read, so the two can never disagree about whether a name is ours.
 *
 * All are pure functions over the registry snapshot the caller reads and
 * the current kit; the callers (resolver.ts, write-details-channel.ts) take
 * the snapshot per tool invocation, which sees the full registry —
 * including names that registered after our own `session_start`.
 */

import type { SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

import type { RenderKit } from "./kit.ts";

/**
 * Whether the pi-fff search extension is present — the yield signal for
 * grep/find.
 *
 * Kept as the explicit fast path alongside the generic occupancy check:
 * FFF's `/fff-mode` command fires at module load (before ANY
 * session_start), so it is order-safe where the tool-name vocabulary is
 * not. Both stay: explicit for the known neighbor, generic for everyone
 * else.
 *
 * @param tools - Tool names visible at the probe (one snapshot).
 * @param commands - Command names visible at the probe (one snapshot).
 * @returns True when an FFF signal is present.
 */
function fffPresent(tools: readonly string[], commands: readonly string[]): boolean {
  return ["fff-mode", "ffgrep", "fffind"].some(
    (name) => tools.includes(name) || commands.includes(name),
  );
}

/**
 * Whether `name` is already claimed by another extension — the generic
 * yield check. Reads pi's merged registry through `getAllTools`: an entry
 * whose source is anything but `builtin` is another extension's
 * definition or an SDK-passed custom tool, and decorating its name would
 * shadow it. Unattributed entries cannot be proven foreign — only
 * hand-rolled mocks omit `sourceInfo` (the SDK always stamps it) — so
 * they never trigger a yield.
 *
 * @param tools - Registry entries visible at the probe (one snapshot).
 * @param name - The tool name to probe.
 * @returns True when another extension already owns the name.
 */
function claimedByOther(tools: readonly ToolInfo[], name: string): boolean {
  return tools.some((tool) => {
    if (tool.name !== name) return false;
    const source = tool.sourceInfo?.source;
    if (source === undefined || source === "builtin") return false;
    return true;
  });
}

/**
 * Whether pi-pigment must yield `name` to pi's own renderers — the one home
 * for the ordered yield rules (ADR 0005), read by both the resolver and the
 * write-details channel so the two can never disagree.
 *
 * Rules, in the resolver's documented order:
 *
 * 1. A name this build cannot decorate; 2. a name another extension owns; 3. pi-fff present (grep/find
 *    only); 4. the name is in `disabledTools`. All four yield the name. The no-kit fail-safe is the
 *    caller's first check — it holds no policy — so `kit` is defined here.
 *
 * @param name - The tool name to decide.
 * @param kit - The current session kit (defined; the caller has already handled no-kit).
 * @param tools - The registry snapshot at the probe.
 * @param commands - The command snapshot at the probe.
 * @returns True when pi-pigment must yield the name.
 */
export function shouldYield(
  name: string,
  kit: RenderKit,
  tools: readonly ToolInfo[],
  commands: readonly SlashCommandInfo[],
): boolean {
  if (!kit.canDecorate(name)) return true;
  if (claimedByOther(tools, name)) return true;
  if (
    (name === "grep" || name === "find") &&
    fffPresent(
      tools.map((tool) => tool.name),
      commands.map((command) => command.name),
    )
  ) {
    return true;
  }
  // Readonly narrowing, not a cast: a `ToolName[]` is a `readonly string[]`.
  const disabled: readonly string[] = kit.config.disabledTools;
  return disabled.includes(name);
}
