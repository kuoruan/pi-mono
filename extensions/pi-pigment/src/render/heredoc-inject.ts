/**
 * Shell-command language injection, AST-driven (@aliou/sh): the parsed
 * command tells us WHERE the code regions are and WHO consumes them —
 * heredoc bodies (python3 << EOF feeds python), heredoc file-writes
 * (cat > app.py << EOF declares the language via the target's extension),
 * and inline code arguments (python -c '...') — so each region renders in
 * its own grammar through the segment pipeline in shell-tool.ts.
 *
 * The parser is the structural authority; the interpreter/extension
 * mappings are OURS (no community table exists). Parsing failures
 * (garbage input) degrade to the regex scanner — the pre-AST fallback —
 * so injection never breaks rendering. (@aliou/sh ≥ 0.3.1 attaches
 * compound-command redirects, so heredocs inside if/for bodies parse —
 * the 0.3.0 "eats the closing keyword" bug is fixed upstream.)
 */

import { type Redirect, type SimpleCommand, type Word, parse } from "@aliou/sh";

import { linesOf } from "#src/core/lines.ts";
import { detectLanguage } from "#src/theme/highlight.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

/** A code region to render in its own grammar, by source offset. */
export interface InjectRegion {
  /** The region's start offset (inclusive), in code units. */
  start: number;
  /** The region's end offset (exclusive), in code units. */
  end: number;
  /** The region's grammar. */
  language: BundledLanguage;
}

/** A heredoc opener: `<< TERM` (or `<<- TERM`) ending the line. */
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*$/;

/**
 * Interpreter commands whose stdin IS source code in a known language —
 * the heredoc injection whitelist. `cat`/`tee` are absent: their heredocs
 * carry data (colored by the file-write target rule instead, when one
 * exists).
 */
const INTERPRETERS: Readonly<Record<string, { language: BundledLanguage; inlineFlags: string[] }>> =
  {
    python: { language: "python", inlineFlags: ["-c"] },
    python2: { language: "python", inlineFlags: ["-c"] },
    python3: { language: "python", inlineFlags: ["-c"] },
    node: { language: "javascript", inlineFlags: ["-e", "--eval"] },
    nodejs: { language: "javascript", inlineFlags: ["-e", "--eval"] },
    deno: { language: "typescript", inlineFlags: ["--eval"] },
    bun: { language: "javascript", inlineFlags: ["-e", "--eval"] },
    tsx: { language: "typescript", inlineFlags: ["-e"] },
    ruby: { language: "ruby", inlineFlags: ["-e"] },
    irb: { language: "ruby", inlineFlags: [] },
    php: { language: "php", inlineFlags: ["-r"] },
    perl: { language: "perl", inlineFlags: ["-e"] },
    psql: { language: "sql", inlineFlags: [] },
    sqlite3: { language: "sql", inlineFlags: [] },
    mysql: { language: "sql", inlineFlags: [] },
    jq: { language: "json", inlineFlags: [] },
    java: { language: "java", inlineFlags: [] },
    go: { language: "go", inlineFlags: [] },
    rustc: { language: "rust", inlineFlags: [] },
    lua: { language: "lua", inlineFlags: ["-e"] },
    r: { language: "r", inlineFlags: ["-e"] },
    rscript: { language: "r", inlineFlags: ["-e"] },
    julia: { language: "julia", inlineFlags: ["-e"] },
  };

/** Heredoc-fed file writers: the redirect target declares the language. */
const FILE_WRITERS = new Set(["cat", "tee", "dash", "bash", "sh", "zsh"]);

/** Redirect operators that write a file (the target declares the language). */
const WRITE_REDIRECT_OPS = new Set([">", ">>", ">|", "<>", "&>", "&>>"]);

/**
 * Extract a Word's literal text. Quoted parts carry their content
 * differently: `SglQuoted` holds it in `.value` directly, `DblQuoted`
 * nests it in inner `parts` (it may contain expansions) — both flatten to
 * the same text, so `cat > "my app.py"` resolves the full path including
 * the space.
 *
 * @param word - The AST word node.
 * @returns The word's text content.
 */
function wordText(word: Word | undefined): string {
  const parts = word?.parts;
  if (!parts?.length) return "";
  return parts
    .map((p) =>
      p.type === "DblQuoted" && p.parts?.length
        ? p.parts
            .map((inner) =>
              inner.type === "Literal" || inner.type === "SglQuoted" ? inner.value : "",
            )
            .join("")
        : p.type === "Literal" || p.type === "SglQuoted"
          ? p.value
          : "",
    )
    .join("");
}

/**
 * The command's program word, unwrapping transparent prefixes — the ONE
 * home for "which prefixes don't change the program": `sudo`, `env`, and
 * env-var assignment words (`env PYTHONPATH=/x python3`; the parser also
 * separates leading assigns out of words on its own). Both AST consumers
 * (heredoc language resolution and inline code-arg detection) resolve
 * through this — prefix transparency must not drift between paths.
 *
 * @param words - The command's word nodes.
 * @returns The program name and the word index it was found at, or null
 *   when every word is a transparent prefix.
 */
function programHead(words: Word[]): { program: string; head: number } | null {
  let skipping = false;
  for (let i = 0; i < words.length; i++) {
    const text = wordText(words[i]);
    const candidate = text.slice(text.lastIndexOf("/") + 1).toLowerCase();
    if (candidate === "sudo" || candidate === "env") {
      skipping = true; // its next word is a flag/option, not a program
      continue;
    }
    if (/^\w+=/.test(text)) continue; // env assignments
    if (skipping && text.startsWith("-")) continue; // sudo/env flags
    skipping = false;
    return { program: candidate, head: i };
  }
  return null;
}

/**
 * The opener context one heredoc resolution needs: the words and the
 * sibling redirects of the SimpleCommand owning the heredoc, WITH their
 * source offsets. Position is the association key: the parser merges
 * consecutive heredoc commands into one node (its words list is the
 * concatenation), but each word and redirect keeps its own offset —
 * filtering by the heredoc's line window recovers the true opener words.
 */
interface OpenerContext {
  /** The command's word nodes (possibly merged across commands). */
  words: Word[];
  /** The command's redirects (including non-heredoc ones like `>`). */
  redirects: Redirect[];
}

/**
 * Resolve the injection language for a heredoc from its opener words and
 * sibling redirects, associated by source position. The AST-native
 * resolution handles: assignment prefixes (`FOO=1 python3 << EOF` — the
 * parser separates assigns from words), quoted write targets
 * (`cat > "my app.py"` — the redirect's target word carries the full path
 * including spaces), and merged-node disambiguation (words on the
 * heredoc's own line only).
 *
 * @param command - The full command text.
 * @param opOffset - The heredoc operator's source offset.
 * @param opener - The owning command's words and redirects.
 * @returns The language, or null when the body is data.
 */
function heredocLanguage(
  command: string,
  opOffset: number,
  opener: OpenerContext,
): BundledLanguage | null {
  const lineStart = command.lastIndexOf("\n", opOffset) + 1;
  // The opener words: this heredoc's line window, before the operator.
  const onLine = (w: Word): boolean => {
    const p = w.pos?.offset;
    return p !== undefined && p >= lineStart && p < opOffset;
  };
  const words = opener.words.filter(onLine);
  // Head resolution: the shared prefix-transparency rule (programHead).
  const resolved = programHead(words);
  if (!resolved) return null;
  const { program, head } = resolved;

  const interpreted = INTERPRETERS[program]?.language;
  if (interpreted) return interpreted;

  // File-write heredocs: the write target declares the language — a
  // write redirect on the opener line carries it as its AST word
  // (quote-aware); `tee [-a] f.py` (no redirect) resolves from its first
  // non-flag argument word.
  if (FILE_WRITERS.has(program)) {
    const writeRedirect = opener.redirects.find((r) => {
      const rop = r.pos?.offset;
      return (
        rop !== undefined &&
        rop >= lineStart &&
        rop < opOffset &&
        WRITE_REDIRECT_OPS.has(r.op ?? "")
      );
    });
    const target = writeRedirect
      ? wordText(writeRedirect.target)
      : program === "tee"
        ? wordText(words.slice(head + 1).find((w) => !wordText(w).startsWith("-")))
        : "";
    if (target && /\.[A-Za-z0-9]+$/.test(target)) {
      return detectLanguage(target) ?? null;
    }
  }
  return null;
}

/**
 * Collect the injection regions of a shell command via its AST.
 *
 * The types come from @aliou/sh's own exported node types (0.3.1+ exports
 * them) — no hand-mirrored views; the walk still guards structurally, so a
 * malformed node shape degrades to the scanner fallback inside the try,
 * never surfaces.
 *
 * @param command - The full command text.
 * @returns The regions (possibly empty), or null when parsing failed —
 *   the caller falls back to the regex scanner.
 */
export function astInjectRegions(command: string): InjectRegion[] | null {
  try {
    const { ast } = parse(command);
    const regions: InjectRegion[] = [];
    // One walk: SimpleCommands yield inline-arg and heredoc regions; nested
    // clauses (if/for/subshell) are traversed structurally. The walk stays
    // inside the try: a malformed node shape must degrade to the scanner
    // fallback like a parse throw does, not surface as a render rejection.
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; [key: string]: unknown };
      if (n.type === "SimpleCommand") {
        const cmd = n as SimpleCommand;
        collectCommandRegions(cmd, regions);
        // The command's own redirects resolve with full opener context
        // (its words + redirects); merged-node ambiguity dissolves in the
        // per-redirect line window (see heredocLanguage).
        const redirects = cmd.redirects ?? [];
        const opener: OpenerContext = { words: cmd.words ?? [], redirects };
        for (const redirect of redirects) collectHeredocRegion(command, redirect, opener, regions);
        return; // children (words/redirects) handled above
      }
      for (const value of Object.values(n)) {
        if (Array.isArray(value)) {
          value.forEach(walk);
        } else if (value && typeof value === "object") {
          walk(value);
        }
      }
    };
    walk(ast);
    // Source order: the walker groups by node kind (commands then their
    // redirects), not by position.
    regions.sort((a, b) => a.start - b.start);
    return regions;
  } catch {
    return null;
  }
}

/**
 * Collect the regions one SimpleCommand contributes: inline code
 * arguments and heredoc bodies.
 *
 * @param cmd - The SimpleCommand node.
 * @param regions - The accumulator.
 */
function collectCommandRegions(cmd: SimpleCommand, regions: InjectRegion[]): void {
  const words = cmd.words ?? [];

  // Inline code arguments: `python -c 'print(1)'` — the quoted word right
  // after the interpreter's code flag. Prefix transparency (sudo/env/
  // assigns) goes through the shared programHead, so `sudo python3 -c`
  // injects like `python3 -c` and like `sudo python3 << EOF` do.
  const resolved = programHead(words);
  const program = resolved?.program ?? "";
  const flags = INTERPRETERS[program]?.inlineFlags;
  if (flags && resolved) {
    for (let i = resolved.head + 1; i < words.length; i++) {
      const word = words[i];
      if (!word) continue;
      const text = wordText(word);
      if (flags.includes(text)) {
        const arg = words[i + 1];
        const language = INTERPRETERS[program]?.language;
        if (arg && language && isQuotedWord(arg)) {
          const start = arg.pos?.offset;
          const end = arg.end?.offset;
          if (start !== undefined && end !== undefined) {
            regions.push({ start: start + 1, end: end - 1, language });
          }
        }
        break; // only the first flag occurrence
      }
    }
  }
}

/**
 * Collect a heredoc redirect's region (the AST walker calls this per
 * redirect, with the owning command's opener context — see
 * heredocLanguage for why association is positional).
 *
 * @param command - The full command text.
 * @param redirect - The heredoc redirect node.
 * @param opener - The owning command's words and redirects.
 * @param regions - The accumulator.
 */
function collectHeredocRegion(
  command: string,
  redirect: Redirect,
  opener: OpenerContext,
  regions: InjectRegion[],
): void {
  if (redirect.op !== "<<" && redirect.op !== "<<-") return;
  const heredoc = redirect.heredoc;
  const start = heredoc?.pos?.offset;
  const heredocEnd = heredoc?.end?.offset;
  const opOffset = redirect.pos?.offset;
  if (start === undefined || heredocEnd === undefined || opOffset === undefined) return;
  const language = heredocLanguage(command, opOffset, opener);
  if (!language) return;
  // The AST's end includes the terminator line; the region is the body —
  // trim back to (and excluding) the terminator line's start.
  let end = heredocEnd;
  const terminator = command.lastIndexOf("\n", end - 1);
  if (terminator >= start) end = terminator + 1;
  if (end <= start) return;
  regions.push({ start, end, language });
}

/**
 * Whether a word is a quoted string (SglQuoted or DblQuoted single part).
 *
 * @param word - The word node.
 * @returns True when the word is one quoted part.
 */
function isQuotedWord(word: Word): boolean {
  const parts = word.parts ?? [];
  return parts.length === 1 && (parts[0]?.type === "SglQuoted" || parts[0]?.type === "DblQuoted");
}

/**
 * The regex-scanner fallback: heredoc REGIONS by line scanning, in the
 * same offset shape the AST path emits — one region model, one assembly
 * loop downstream. Used when the AST parse throws (garbage input, or the
 * upstream parser bug where heredocs inside control-flow bodies eat the
 * closing keyword). An unterminated body produces no region (the command
 * renders purely in shell grammar).
 *
 * @param command - The full command text.
 * @returns The code regions, in source order.
 */
export function fallbackHeredocRegions(command: string): InjectRegion[] {
  const regions: InjectRegion[] = [];
  let pendingTerm: string | null = null;
  let bodyStart = 0; // offset of the line after the opener
  let language: BundledLanguage | null = null;
  let offset = 0;
  for (const line of linesOf(command)) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline (safe at the tail)
    if (pendingTerm !== null) {
      if (line.trim() === pendingTerm) {
        // Region: the body up to (excluding) the terminator line.
        if (language && lineStart > bodyStart) {
          regions.push({ start: bodyStart, end: lineStart, language });
        }
        pendingTerm = null;
        language = null;
      }
      continue;
    }
    const start = line.match(HEREDOC_START);
    if (start) {
      language = scannerOpenerLanguage(line);
      pendingTerm = start[2] ?? null;
      bodyStart = offset;
    }
  }
  return regions;
}

/**
 * The scanner's opener-language resolution (interpreter whitelist only).
 *
 * @param opener - The line opening the heredoc.
 * @returns The language, or null.
 */
function scannerOpenerLanguage(opener: string): BundledLanguage | null {
  const head = opener.slice(0, opener.indexOf("<<")).trim();
  const last = head.split(/(?:&&|;|\|\|)/).pop() ?? head;
  const token = last.trim().split(/\s+/)[0] ?? "";
  const program = token.slice(token.lastIndexOf("/") + 1).toLowerCase();
  return INTERPRETERS[program]?.language ?? null;
}
