/**
 * The deterministic floor: facts that make an action irreversible, and the
 * rule that a model's `allow` cannot lift them.
 *
 * The ladder maps only what the reviewer emits (`applyVerdictMode` returns an
 * allow untouched), so without this floor a model that reads "the user asked
 * for it" as authorization can silently pass an action the deterministic facts
 * already prove unrecoverable. On the classifier lane the floor is inert for
 * every anchored corpus case measured so far (20 cases whose facts fire it —
 * the decision table allows none of them); a classifier allow the floor meets
 * would still ask, exactly as a reviewer allow does.
 *
 * Scope is a closed list, each entry backed by a signed escalator decision or
 * by a corpus case whose impact record says `needs_human`:
 *
 * - `rewritesHistory` — discards work no stored revision holds. Asks even when the anchor names it
 *   (Scheme A: `requested && !escalated → allow`).
 * - A recursive delete outside the working directory — removes a whole tree the project does not own.
 *   A scratch path (`/tmp/...`) and a non-recursive single file are deliberately outside this rule:
 *   the corpus allows both when they were asked for.
 * - `installsPersistence`, `allInterfaces`, `sendsData`, `rawCopy` — the same signed escalator
 *   family; each turns a reversible-looking command into one whose effect outlives the turn (a
 *   drop-in startup hook, a listener on every interface, credential-shaped data leaving, a raw
 *   block copy).
 *
 * The floor answers whether an allow must be raised; it never denies, and it
 * never lowers a stricter verdict. The cost of a false positive is one
 * confirmation; the cost of a false negative is an irrecoverable action with
 * no record at all.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { IrreversibleRuling } from "#src/config/config-schema.ts";
import type { CommandFacts } from "#src/review/request/command-facts.ts";

/**
 * The facts that floor a model allow, in the order the record names them.
 * A readonly list so the caller renders a stable, testable summary.
 */
export interface FloorHit {
  /** The fact names that fired, in declaration order. */
  readonly facts: readonly string[];
  /** The single sentence shown as the verdict's reason and in the audit record. */
  readonly reason: string;
}

/**
 * Read the deterministic floor from one command's facts.
 *
 * @param facts - The command facts, or null for a non-bash surface.
 * @returns The fired facts and their reason, or null when the action is
 *   recoverable (or nothing was proven).
 */
export function floorOf(facts: CommandFacts | null): FloorHit | null {
  if (facts === null) return null;
  const hits: string[] = [];
  if (facts.rewritesHistory) hits.push("rewrites-history");
  if (facts.commandEffect === "delete" && facts.recursive && facts.pathScope === "outside") {
    hits.push("recursive-delete-outside");
  }
  if (facts.installsPersistence) hits.push("installs-persistence");
  if (facts.allInterfaces) hits.push("all-interfaces");
  if (facts.sendsData) hits.push("sends-data");
  if (facts.rawCopy) hits.push("raw-copy");
  if (hits.length === 0) return null;
  return { facts: hits, reason: floorReason(hits) };
}

/**
 * What each fact means, in the operator's terms. The six entries are not
 * interchangeable: a history rewrite destroys work no revision holds, a
 * persistence install outlives the turn, an all-interfaces listener exposes
 * the machine. One blanket sentence would overclaim for every one of them.
 */
export const FLOOR_FACT_LABELS: Readonly<Record<string, string>> = {
  "rewrites-history": "it discards work no stored revision holds",
  "recursive-delete-outside": "it removes a whole tree outside the project",
  "installs-persistence": "it installs something that outlives this session",
  "all-interfaces": "it listens beyond this machine instead of loopback",
  "sends-data": "it hands credential-shaped data to a remote endpoint",
  "raw-copy": "it copies raw blocks outside any named file",
};

/**
 * The human-facing reason for a floor hit.
 *
 * @param facts - The fired fact names.
 * @returns One sentence naming each proven effect and why it needs confirmation.
 */
export function floorReason(facts: readonly string[]): string {
  const effects = facts.map((fact) => FLOOR_FACT_LABELS[fact] ?? fact).join("; ");
  return `the command facts prove ${effects}, so this needs your confirmation`;
}

/**
 * The agent-facing reason for a floor deny: the same fact sentence as the ask,
 * restated as a refusal rather than a request for confirmation.
 *
 * @param hit - The fired facts.
 * @returns The deny reason, without the agent instruction (the release adds it).
 */
export function floorDenyReason(hit: FloorHit): string {
  return `${hit.reason}, and this mode refuses that class of action outright`;
}

/**
 * A fired floor hit plus the mode's ruling on it: the release's input for a
 * floored allow. The ruling excludes `allow` structurally — an `allow` ruling
 * leaves the verdict alone, so there is nothing for the release to override.
 */
export interface FloorRuling {
  readonly hit: FloorHit;
  readonly ruling: Exclude<IrreversibleRuling, "allow">;
}

/**
 * The fired hit for a reviewer allow, or null. A defer is never floored — not
 * even one the mode maps to allow: that leniency is the mode's own decision,
 * not a reviewer judgment the facts can contradict. A deny is never lowered
 * either. What the release makes of a hit (ask or block) lives in the release,
 * next to the copy it emits — one home for the rule, one for its expression.
 *
 * @param verdict - The reviewer's verdict.
 * @param facts - The command facts, or null for a non-bash surface.
 * @returns The hit, or null when nothing fired.
 */
export function floorHitFor(
  verdict: AuthorizerVerdict,
  facts: CommandFacts | null,
): FloorHit | null {
  return verdict.kind === "allow" ? floorOf(facts) : null;
}
