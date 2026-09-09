/**
 * The diff model: pure parsers producing the ParsedDiff structure the
 * renderers consume. `parseDiff` diffs two strings; `parsePatchFiles` parses
 * unified patch text (e.g. the edit tool's `details.patch`). Hunk separators
 * render with the single auto style — context line when the hunk header
 * carries one, else skipped-line count.
 */

import { structuredPatch } from "diff";

import { inertText } from "./ansi.ts";
import { linesOf } from "./lines.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Hunk metadata parsed from a `@@` header, attached to separator DiffLines. */
export interface HunkMeta {
  /** First old-file line number covered by the hunk. */
  oldStart: number;
  /** Line count covered in the old file. */
  oldLines: number;
  /** First new-file line number covered by the hunk. */
  newStart: number;
  /** Line count covered in the new file. */
  newLines: number;
  /** Function context from hunk header, e.g. "function foo() {" */
  context?: string;
}

/** One line of a parsed diff, typed by its role in the hunk. */
export interface DiffLine {
  /** The line's role: added, removed, context, or hunk separator. */
  type: "add" | "del" | "ctx" | "sep";
  /** Old-file line number (null for added and separator lines). */
  oldNum: number | null;
  /** New-file line number (null for removed and separator lines). */
  newNum: number | null;
  /** The line's text content (empty for separators). */
  content: string;
  /** Between-hunk skipped unmodified lines (separator lines only). */
  gap?: number;
  /** Hunk metadata — present on separator lines. */
  hunkMeta?: HunkMeta;
}

/** A fully parsed diff: typed lines plus the aggregate stats the renderers use. */
export interface ParsedDiff {
  /** The diff's lines in order, including separators. */
  lines: DiffLine[];
  /** Count of added lines. */
  added: number;
  /** Count of removed lines. */
  removed: number;
}

// ---------------------------------------------------------------------------
// Unified diff patch parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff/patch string into one or more ParsedDiff.
 * Each file in the patch gets its own entry. Invalid hunk content or line
 * counts fail closed (empty result).
 *
 * @param patch - Unified diff text.
 * @returns One ParsedDiff per file, or [] when the patch is unusable.
 */
export function parsePatchFiles(patch: string): ParsedDiff[] {
  if (!patch.trim()) return [];

  // Split into file sections. A new file starts at `diff --git`/`Index:`
  // headers, or at a `--- `/`+++ ` pair — one linear pass with the section
  // header presence tracked as a flag (re-scanning the section per line
  // would be quadratic).
  const lines = linesOf(patch);
  const sections: string[][] = [];
  let cur: string[] = [];
  let curHasHeader = false;
  // Track whether the current section's hunk is still open (its declared
  // line counts are not yet consumed): a `--- `/`+++ ` pair inside an open
  // hunk is marker-prefixed SOURCE, not a new-file header.
  let hunkRemaining = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hunk = parseHunkHeader(line);
    if (hunk) hunkRemaining = hunk.oldLines + hunk.newLines;
    const startsNewFile =
      line.startsWith("diff --git ") ||
      line.startsWith("Index: ") ||
      // A `--- `/`+++ ` pair opens a new file only when the current section
      // has no diff/index header (after one, the pair is the same file's
      // metadata) AND no hunk is still open (inside a hunk it is
      // marker-prefixed source content).
      (line.startsWith("--- ") &&
        lines[i + 1]?.startsWith("+++ ") &&
        !curHasHeader &&
        hunkRemaining === 0);
    if (startsNewFile && cur.length > 0) {
      sections.push(cur);
      cur = [];
      curHasHeader = false;
      hunkRemaining = 0;
    } else if (hunkRemaining > 0) {
      // Hunk body lines consume the declared counts (context/add/del).
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
        hunkRemaining -= 1;
      }
    }
    if (line.startsWith("diff --git ") || line.startsWith("Index: ")) curHasHeader = true;
    cur.push(line);
  }
  if (cur.length > 0) sections.push(cur);

  const result: ParsedDiff[] = [];
  for (const section of sections) {
    const hasHunk = section.some((line) => parseHunkHeader(line));
    const looksLikeFileSection = section.some(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("Index: ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ "),
    );
    if (!hasHunk) {
      if (looksLikeFileSection) return [];
      continue;
    }
    const parsed = parseOneFile(section);
    if (!parsed) return [];
    result.push(parsed);
  }
  return result;
}

/**
 * Whether a line is patch metadata (file headers, index lines, mode changes)
 * rather than hunk content.
 *
 * @param line - A patch line.
 * @returns True when the line is metadata.
 */
function isPatchMetadataLine(line: string): boolean {
  return /^(?:diff --git |Index: |={3,}$|--- |\+\+\+ |index |new file |old mode |new mode |deleted |rename |similarity |copy |Binary files )/.test(
    line,
  );
}

/**
 * Parse a single file section. Invalid hunk content or line counts fail closed.
 *
 * @param lines - The section's lines.
 * @returns The parsed diff, or null when the section is invalid.
 */
function parseOneFile(lines: string[]): ParsedDiff | null {
  const all: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let prevMeta: HunkMeta | undefined;

  while (i < lines.length) {
    const hdr = parseHunkHeader(lines[i]);
    if (!hdr) {
      if (lines[i].startsWith("@@") || lines[i].startsWith("\\ ") || !isPatchMetadataLine(lines[i]))
        return null;
      i++;
      continue;
    }

    // Between-hunk sep carries the skipped-line gap (same as parseDiff);
    // the first hunk's sep has none.
    const gap = prevMeta ? (hunkGap(prevMeta, hdr) ?? undefined) : undefined;
    all.push({ type: "sep", oldNum: null, newNum: null, content: "", gap, hunkMeta: hdr });
    let oldConsumed = 0;
    let newConsumed = 0;
    let oldLine = hdr.oldStart;
    let newLine = hdr.newStart;
    i++;

    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("@@")) {
        if (!parseHunkHeader(line)) return null;
        break;
      }
      if (line.length === 0) {
        if (i !== lines.length - 1) return null;
        i++;
        continue; // terminal newline after the patch
      }
      if (line === "\\ No newline at end of file") {
        i++;
        continue;
      }
      if (line[0] === " ") {
        all.push({
          type: "ctx",
          oldNum: oldLine++,
          newNum: newLine++,
          content: inertText(line.slice(1)),
        });
        oldConsumed++;
        newConsumed++;
      } else if (line[0] === "+") {
        all.push({
          type: "add",
          oldNum: null,
          newNum: newLine++,
          content: inertText(line.slice(1)),
        });
        added++;
        newConsumed++;
      } else if (line[0] === "-") {
        all.push({
          type: "del",
          oldNum: oldLine++,
          newNum: null,
          content: inertText(line.slice(1)),
        });
        removed++;
        oldConsumed++;
      } else {
        return null;
      }
      i++;
    }

    if (oldConsumed !== hdr.oldLines || newConsumed !== hdr.newLines) return null;
    prevMeta = hdr;
  }

  if (all.every((line) => line.type === "sep")) return null;
  return { lines: all, added, removed };
}

/**
 * Parse a hunk header line like:
 *
 * `@@ -oldStart,oldCount +newStart,newCount @@` optional func context
 *
 * @param line - A candidate hunk header line.
 * @returns The hunk metadata, or null when not a hunk header.
 */
function parseHunkHeader(line: string): HunkMeta | null {
  const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:\s+(.*))?$/);
  if (!m) return null;
  const oldStart = Number(m[1]);
  const oldLines = m[2] ? Number(m[2]) : 1;
  const newStart = Number(m[3]);
  const newLines = m[4] ? Number(m[4]) : 1;
  const context = m[5]?.trim() || undefined;
  return { oldStart, oldLines, newStart, newLines, context };
}

// ---------------------------------------------------------------------------
// Hunk gap and separator labels
// ---------------------------------------------------------------------------

/**
 * Skipped unmodified old-file lines between two hunks — the single gap
 * authority both parsers use (null when the hunks are adjacent or overlap).
 *
 * @param prev - The earlier hunk's metadata.
 * @param cur - The later hunk's metadata.
 * @returns The gap, or null when not positive.
 */
function hunkGap(prev: HunkMeta, cur: HunkMeta): number | null {
  const gap = cur.oldStart - (prev.oldStart + prev.oldLines);
  return gap > 0 ? gap : null;
}

/**
 * Hunk separator label: the hunk's function context when the header carries
 * one, else the skipped-line count. Empty when nothing useful to show.
 *
 * @param hunkMeta - The hunk's metadata (function context).
 * @param gap - The sep line's skipped-line count, or null.
 * @returns The separator label.
 */
export function sepLabel(hunkMeta: HunkMeta | undefined, gap: number | null): string {
  // The hunk context is patch-sourced text (a function-context line from
  // the file body) — inert even though today's producers never set it
  // (parseDiff sets no context; the SDK's two-file patches carry none):
  // a future producer must not re-open an injection path by accident.
  const ctx = hunkMeta?.context;
  if (ctx && gap && gap > 0) return ` ${inertText(ctx)} — +${gap} lines `;
  if (ctx) return ` ${inertText(ctx)} `;
  if (gap && gap > 0) return ` +${gap} lines `;
  return "";
}

// ---------------------------------------------------------------------------
// Programmatic diff (string-to-string)
// ---------------------------------------------------------------------------

/**
 * Diff two strings into a ParsedDiff with `ctx` lines of context per hunk.
 *
 * @param oldContent - The old file content.
 * @param newContent - The new file content.
 * @param ctx - Context lines kept around each hunk.
 * @returns The parsed diff.
 */
export function parseDiff(oldContent: string, newContent: string, ctx = 3): ParsedDiff {
  const patch = structuredPatch("", "", oldContent, newContent, "", "", { context: ctx });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  for (let hi = 0; hi < patch.hunks.length; hi++) {
    const h = patch.hunks[hi];
    const meta: HunkMeta = {
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
    };

    // Emit hunk metadata as a synthetic sep (position 0 for first hunk,
    // between-hunk sep for subsequent). This ensures every hunk has metadata.
    const prev = hi > 0 ? patch.hunks[hi - 1] : undefined;
    const gap = prev ? (hunkGap(prev, h) ?? undefined) : undefined;
    lines.push({ type: "sep", oldNum: null, newNum: null, content: "", gap, hunkMeta: meta });

    let oL = h.oldStart;
    let nL = h.newStart;
    for (const raw of h.lines) {
      if (raw === "\\ No newline at end of file") continue;
      const ch = raw[0];
      const text = inertText(raw.slice(1));
      if (ch === "+") {
        lines.push({ type: "add", oldNum: null, newNum: nL++, content: text });
        added++;
      } else if (ch === "-") {
        lines.push({ type: "del", oldNum: oL++, newNum: null, content: text });
        removed++;
      } else {
        lines.push({ type: "ctx", oldNum: oL++, newNum: nL++, content: text });
      }
    }
  }
  return { lines, added, removed };
}
