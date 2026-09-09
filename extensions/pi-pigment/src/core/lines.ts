/**
 * Plain-text line utilities: the small pure helpers every wrapper reaches
 * for when turning file text into line-shaped views (counts, prefixes,
 * splits). No ANSI knowledge — string in, string/number out.
 */

/**
 * A text's line view — THE canonical split every fallback path uses
 * (hlBlock's unstyled exits, the seed's text form). Splitting a text
 * into lines is a one-liner; this homes the SEMANTIC choice (the "a\nb\n"
 * tail-newline shape: a trailing newline does not add a trailing empty
 * line here only when callers pass pre-trimmed text — the fallback paths
 * mirror shiki's contract, see hlBlock) in one place.
 *
 * @param text - The text.
 * @returns The lines.
 */
export function linesOf(text: string): string[] {
  return text.split("\n");
}

/**
 * Count a text's lines without allocating (the streaming frames re-run
 * this over the full accumulated content; split().length would pay an
 * array per frame). A TRAILING newline adds no line — the count matches
 * what the preview bodies actually render (hlBlock trims one trailing
 * newline per its line contract), so "x\n" counts 1, not 2 (the old
 * split-based count made the create header read "(2 lines)" over a
 * one-row body).
 *
 * @param text - The text ("a\nb" is 2 lines; "" is 1).
 * @returns The line count.
 */
export function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * The text BEFORE a 1-based line number — the grammar-state seed's slice
 * ("lines 1..start-1"): write slices the args text, edit slices its
 * cached file snapshot's lines (the array form — no join-then-resplit).
 * Line 1 and below have no before-text.
 *
 * @param lines - The full text's lines.
 * @param start - The 1-based line the seed leads INTO.
 * @returns The before-text, or undefined when nothing precedes it.
 */
export function linesBefore(lines: readonly string[], start: number): string | undefined {
  if (start <= 1) return undefined;
  return lines.slice(0, start - 1).join("\n");
}

/**
 * The text form of {@link linesBefore} (splits first).
 *
 * @param text - The full text.
 * @param start - The 1-based line the seed leads INTO.
 * @returns The before-text, or undefined when nothing precedes it.
 */
export function textBeforeLine(text: string, start: number): string | undefined {
  if (start <= 1) return undefined;
  return linesBefore(linesOf(text), start);
}
