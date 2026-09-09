/**
 * Pattern emphasis: an SGR-span-aware rewriter that emphasizes pattern
 * occurrences inside already-highlighted text (grep hit lines), plus the
 * ReDoS gate deciding which patterns may compile. No grep concepts live
 * here — the module is a generic text-rewriting primitive; the grep and
 * find wrappers are its clients (grep: the pattern; find: the glob's
 * anchor run).
 */

import { RESET } from "#src/core/ansi.ts";
import { createBoundedMap } from "#src/core/bounded-map.ts";

/** How the caller wants the pattern matched (grep/find flags). */
export interface MatchFlags {
  /** Literal substring semantics (skip regex compilation). */
  literal: boolean;
  /** Case-insensitive matching. */
  ignoreCase: boolean;
}

/** A resolved matcher: a compiled regex, a literal needle, or neither. */
export interface PatternMatcher {
  /** The safe-compiled regex (null when literal or risky). */
  regex: RegExp | null;
  /** The literal needle (null unless literal semantics). */
  needle: string | null;
}

/**
 * SGR sequence splitter (module-level: compiling per call was the hot
 * path).
 */
const ESC = String.fromCharCode(27);
/** Splits a rendered line at SGR escapes, keeping the escapes as segments. */
const SGR_SPLIT = new RegExp(`(${ESC}\\[[0-9;]*m)`);

/**
 * Compiled matcher per (pattern, literal, ignoreCase) — small bounded memo:
 * one grep renders many lines with the SAME pattern; recompiling per line
 * was ~2 regex constructions per rendered line.
 */
const matcherMemo = createBoundedMap<string, PatternMatcher>(64);

/**
 * Resolve the matcher for a pattern under grep/find semantics: regex hits
 * per span by default, literal substring when literal:true, none when the
 * regex is broken or risky (ReDoS gate). Memoized per pattern+flags.
 *
 * @param pattern - The pattern source.
 * @param flags - The matching flags (literal / ignoreCase).
 * @returns The compiled regex, the literal needle, or neither.
 */
function matcherFor(pattern: string, flags: MatchFlags): PatternMatcher {
  const key = `${flags.literal ? "l" : "r"}:${flags.ignoreCase ? "i" : "s"}:${pattern}`;
  const memoized = matcherMemo.get(key);
  if (memoized) return memoized;
  const resolved: PatternMatcher =
    flags.literal || riskyPattern(pattern)
      ? { regex: null, needle: flags.literal ? pattern : null }
      : { regex: safeRegex(pattern, flags.ignoreCase), needle: null };
  matcherMemo.set(key, resolved);
  return resolved;
}

/** The emphasis convention's color half: the theme's accent foreground. */
export interface EmphasisSpec {
  /** The accent fg escape emphasize applies over each match. */
  fg: string;
}

/**
 * The emphasis convention's color half: the theme's accent foreground.
 * BOLD (the other half) lives inside emphasize; callers pass this spec —
 * one derivation beside the wrap that consumes it, no per-wrapper copies
 * of the rule or its rationale.
 *
 * @param theme - The pi theme.
 * @returns The emphasis spec emphasize takes.
 */
export function accentEmphasis(theme: { getFgAnsi(name: string): string }): EmphasisSpec {
  return { fg: theme.getFgAnsi("accent") };
}

/** The emphasize inputs. */
export interface EmphasizeOptions {
  /** The content to wrap (ANSI spans intact). */
  content: string;
  /** The pattern source ("": pass through untouched). */
  pattern: string;
  /** The flags (literal / ignoreCase). */
  flags: MatchFlags;
  /** The emphasis spec (bold fg wrap). */
  emphasis: EmphasisSpec;
  /** The base fg re-opened after each match's RESET ("" = plain). */
  baseFg?: string;
}

/**
 * Re-render a line's grep matches with the emphasis style (bold + fg) over
 * the syntax highlighting.
 *
 * @param options - The emphasis inputs.
 * @returns The line with every match emphasized.
 */
export function emphasize(options: EmphasizeOptions): string {
  const { content, pattern, flags, emphasis, baseFg = "" } = options;
  if (!pattern) return content;
  const spans = content.split(SGR_SPLIT);

  // Emphasis must never fight the span's own syntax color: after each hit,
  // re-open the fg escape that was active on entry (a bare RESET left the
  // span's remainder uncolored). The emphasis signal itself is BOLD +
  // independent fg (the CLI convention — ripgrep, GNU grep, and git grep
  // all render matches as bold-plus-distinct-color): bold stays visible
  // even where the fg happens to match a token color.
  const BOLD = "\x1b[1m";
  // The fg active before each match — the emphasis wrap RESETs, so the
  // remainder must re-open the span it was in; plain-text callers pass
  // their base fg so the text after a match keeps it (highlighted callers
  // leave it empty: their spans carry their own re-opens).
  let spanFg = baseFg;
  const wrap = (hit: string) => `${BOLD}${emphasis.fg}${hit}${RESET}${spanFg}`;

  // Matcher per grep/find semantics (memoized — see matcherFor).
  const { regex, needle } = matcherFor(pattern, flags);

  return spans
    .map((span) => {
      if (span.startsWith(ESC)) {
        // Track the span's effective fg: a reset clears it, an fg escape
        // (possibly inside a compound sequence) re-opens it, anything else
        // (bg-only, attributes) leaves the current fg standing.
        if (span === RESET || span === "\x1b[m") {
          spanFg = "";
        } else if (FG_ONLY.test(span)) {
          spanFg = span;
        }
        return span; // escape span: untouched
      }
      if (regex) {
        try {
          // Empty matches wrap nothing (an `x*` pattern matches at every
          // position): skip them — the wrap is ~20 bytes of SGR per hit and
          // an empty hit would bloat the span with pure escape noise.
          return span.replace(regex, (hit) => (hit ? wrap(hit) : hit));
        } catch {
          return span;
        }
      }
      if (!needle) return span;
      if (!flags.ignoreCase) {
        return span.split(needle).join(wrap(needle));
      }
      // Case-insensitive literal: locate on the lowered text, slice the
      // original so casing is preserved inside the emphasis.
      const lowered = span.toLowerCase();
      const lowerNeedle = needle.toLowerCase();
      let out = "";
      let i = 0;
      let idx = lowered.indexOf(lowerNeedle);
      while (idx !== -1) {
        out += span.slice(i, idx);
        out += wrap(span.slice(idx, idx + needle.length));
        i = idx + needle.length;
        idx = lowered.indexOf(lowerNeedle, i);
      }
      return out + span.slice(i);
    })
    .join("");
}

/** An SGR span that sets a foreground color (the emphasis re-opens it). */
// eslint-disable-next-line no-control-regex -- intentionally matches ESC
const FG_ONLY = /\x1b\[3[0-9](?:;[0-9]+)*m|\x1b\[38;5;\d+m|\x1b\[38;2;\d+;\d+;\d+m/;

/**
 * Whether a regex pattern risks catastrophic backtracking in JS's
 * backtracking engine: a quantifier applied to a group that can match one
 * text multiple ways (contains a quantifier, an alternation, a dot, or a
 * backreference). ripgrep runs such patterns in linear time, so they arrive
 * here having "worked" — while the same pattern can hang the TUI's render
 * loop for minutes. Conservative: a false positive only skips
 * emphasis (cosmetic); a false negative freezes the whole UI. Character
 * classes are safe (each position matches one way) and skipped.
 *
 * @param pattern - The grep pattern source.
 * @returns True when emphasis should degrade to no-regex.
 */
export function riskyPattern(pattern: string): boolean {
  let i = 0;
  // Stack of group bodies (start indices); we check each on quantified close.
  const groupStarts: number[] = [];
  // Track whether any group currently open contains a risky inner token.
  const groupRisky: boolean[] = [];
  let inClass = false;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "\\") {
      const next = pattern[i + 1];
      // Backreference inside any open group (or anywhere): NP-hard
      // matching — numbered (\\1) and named (\\k<name>) forms alike.
      if (next && /[1-9]/.test(next)) return true;
      if (next === "k") return true;
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (ch === "(") {
      groupStarts.push(i);
      groupRisky.push(false);
      // Skip the group's syntax prefix — (?: (?= (?! (?< — so its letters
      // (notably the "?" of "(?:") are never misread as quantifiers.
      const rest = pattern.slice(i + 1, i + 3);
      i +=
        rest.startsWith("?:") ||
        rest.startsWith("?=") ||
        rest.startsWith("?!") ||
        rest.startsWith("?<")
          ? 3
          : 1;
      continue;
    }
    if (ch === ")") {
      const start = groupStarts.pop();
      const wasRisky = groupRisky.pop() ?? false;
      // Quantifier right after the close?  The group is now the quantified
      // unit — dangerous iff its body could match one text multiple ways.
      const next = pattern[i + 1];
      if (start !== undefined && next && "+*{".includes(next)) {
        if (wasRisky) return true;
      } else if (start !== undefined && next === "?") {
        if (wasRisky) return true;
      }
      // A closed risky group makes enclosing groups risky too ((a+)+).
      if (wasRisky && groupRisky.length > 0) groupRisky[groupRisky.length - 1] = true;
      i++;
      continue;
    }
    if (ch === "|" || ch === ".") {
      for (let g = 0; g < groupRisky.length; g++) groupRisky[g] = true;
      i++;
      continue;
    }
    if ("+*?".includes(ch)) {
      // Any quantifier inside a group makes that group able to match one
      // text multiple ways ([a-z]+ included — the class matches one char,
      // the quantifier matches many). A quantifier directly after `)` or
      // `]` at group depth 0 is linear and needs no mark; inside a group
      // the mark is what makes the enclosing quantified group risky.
      for (let g = 0; g < groupRisky.length; g++) groupRisky[g] = true;
      i++;
      continue;
    }
    if (ch === "{") {
      // {m,n} quantifier — same treatment as +*/?. (Also rejects \{ as a
      // literal brace only when it parses as a quantifier; a lone { is a
      // literal in JS and harmless here either way.)
      const close = pattern.indexOf("}", i);
      if (close !== -1 && /^\{\d+(,\d*)?\}$/.test(pattern.slice(i, close + 1))) {
        for (let g = 0; g < groupRisky.length; g++) groupRisky[g] = true;
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  // No quantified group can match one text multiple ways: linear in JS.
  return false;
}

/**
 * Compile a grep pattern into a RegExp; null when it does not compile.
 *
 * @param pattern - The grep pattern source.
 * @param ignoreCase - Whether the grep ran case-insensitively.
 * @returns The RegExp, or null.
 */
function safeRegex(pattern: string, ignoreCase: boolean): RegExp | null {
  try {
    return new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch {
    return null;
  }
}
