import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The notify skeleton, mechanically enforced: no structural colons in any
 * static notify text. The TUI prefixes its own level ("Warning: …") — a
 * colon inside our line doubles up. Detail rides in parentheses or after
 * an em-dash; a URL scheme ("https://…") is not structural. Scans the
 * notify-producing sources so a copy edit cannot reintroduce the shape.
 */
const NOTIFY_SOURCES = [
  "#src/session/session-lifecycle.ts",
  "#src/review/review-pipeline.ts",
  "#src/session/runtime-settings.ts",
  "#src/review/verdict-mode.ts",
] as const;

/** The notify call prefixes whose first argument this test scans. */
const CALL_RE = /(?:deps\.notify|feedbackNotify|this\.#deps\.notify)\(/g;

/**
 * Extract the static text of a notify call's first argument, or undefined
 * when the argument is not a literal (a dynamic expression is not copy).
 *
 * Nesting-aware, unlike the flat regex it replaced: a template literal's
 * `${...}` interpolations are dropped wholesale (variable text is not
 * copy), but template/string literals NESTED inside an interpolation are
 * conditional copy — they render when the branch holds — so their literal
 * parts are kept and their own interpolations dropped recursively. A flat
 * regex stops at the first backtick and silently mis-splits the argument.
 *
 * @param source - The whole source file.
 * @param start - Index just past the call's opening `(`.
 * @returns The static text the line can render, or undefined when the
 *   first argument does not start with a literal.
 */
function staticNotifyText(source: string, start: number): string | undefined {
  let i = start;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const opener = source[i];
  if (opener !== "`" && opener !== '"') return undefined;
  return scanLiteral(source, i).text;
}

/**
 * Scan one template or double-quoted string literal starting at `i`.
 *
 * @param source - The whole source file.
 * @param i - Index of the opening delimiter.
 * @returns The literal's static text and the index just past its closer.
 */
function scanLiteral(source: string, i: number): { text: string; end: number } {
  const opener = source[i]!;
  let out = "";
  i++;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      // An escaped character renders as itself (backslash-newline joins lines).
      const next = source[i + 1] ?? "";
      out += next === "\n" ? "" : next;
      i += 2;
      continue;
    }
    if (opener === "`" && c === "$" && source[i + 1] === "{") {
      // Interpolation: drop the expression, keep any literals nested in it.
      out += scanInterpolation(source, i + 2).text;
      i = scanInterpolation(source, i + 2).end;
      continue;
    }
    if (c === opener) return { text: out, end: i + 1 };
    out += c;
    i++;
  }
  return { text: out, end: i };
}

/**
 * Scan an interpolation body (from just past `${`) to its balancing `}`.
 *
 * @param source - The whole source file.
 * @param i - Index just past the opening `${`.
 * @returns The nested literals' text (conditional copy) and the index just
 * past the closing `}`.
 */
function scanInterpolation(source: string, i: number): { text: string; end: number } {
  let out = "";
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i]!;
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      continue;
    }
    if (c === "`" || c === '"' || c === "'") {
      // Conditional copy: keep the nested literal's own static text.
      const scanned = scanLiteral(source, i);
      out += scanned.text;
      i = scanned.end;
      continue;
    }
    i++;
  }
  return { text: out, end: i };
}

describe("notify skeleton — no structural colons", () => {
  it("every static notify literal is colon-free", () => {
    const offenders: string[] = [];
    for (const f of NOTIFY_SOURCES) {
      const s = readFileSync(fileURLToPath(import.meta.resolve(f)), "utf-8");
      for (const m of s.matchAll(CALL_RE)) {
        const staticText = staticNotifyText(s, m.index! + m[0].length);
        if (staticText === undefined) continue;
        if (/:\s/.test(staticText) && !staticText.includes("http")) {
          offenders.push(`${f}: ${JSON.stringify(staticText.slice(0, 60))}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner keeps nested conditional copy and drops interpolations", () => {
    // A nested template inside an interpolation renders when the branch
    // holds — its literal parts are copy a colon check must see. The
    // scanner over-approximates the union of branches (both `inner: colon`
    // and the else-literal "v" are kept); a false-positive colon in a dead
    // branch is acceptable linting, a miss is not.
    const nested = 'deps.notify(`outer ${cond ? `inner: colon` : "v"} tail`)';
    expect(staticNotifyText(nested, nested.indexOf("(") + 1)).toBe("outer inner: colonv tail");
    // A plain interpolation is variable text, not copy.
    const plain = "deps.notify(`code ${exit.code} done`)";
    expect(staticNotifyText(plain, plain.indexOf("(") + 1)).toBe("code  done");
    // Single-quoted conditional branches are copy too (same as double).
    const single = 'deps.notify(`status ${ok ? "fine" : `broken: retry`}`)';
    expect(staticNotifyText(single, single.indexOf("(") + 1)).toBe("status finebroken: retry");
    // A dynamic first argument is skipped entirely (not a literal).
    const dynamic = "deps.notify(message(level))";
    expect(staticNotifyText(dynamic, dynamic.indexOf("(") + 1)).toBeUndefined();
  });
});
