/**
 * The grep tool wrapper: execution delegates to the SDK's grep tool (via the
 * tool-wrapper factory); rendering highlights hit lines in the hit file's
 * language with the matched pattern emphasized (literal/regex/ignoreCase
 * semantics honored), `file:line:` prefixes muted, context lines dimmer.
 */

import type { GrepToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { inertText } from "#src/core/ansi.ts";
import { SEQ_FG_DEFAULT } from "#src/core/escapes.ts";
import { MAX_HL_CHARS } from "#src/theme/highlight.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { DiffPalette, PaletteTheme } from "#src/theme/palette.ts";
import type { BundledLanguage } from "#src/theme/shiki-core.ts";

import { renderHeaderLine } from "./ellipsis.ts";
import { assembleOutputBody } from "./output-assembly.ts";
import { accentEmphasis, emphasize, type MatchFlags } from "./pattern-emphasis.ts";
import type { RenderView } from "./session.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { COLLAPSED_LINES, joinBodyTail, outputMemoOf, renderPlainOutput } from "./tool-output.ts";
import {
  argsOf,
  argStr,
  headerPath,
  invalidArg,
  resultStreaming,
  type ToolServices,
} from "./tool-services.ts";

/**
 * The grep call header: the SDK's formatGrepCall, byte for byte
 * (toolTitle name, accent /pattern/, toolOutput path/glob/limit).
 *
 * @param args - The settled grep args.
 * @param theme - The pi theme.
 * @returns The header row (no trailing gap — the caller owns it).
 */
function formatGrepCall(args: Partial<GrepToolInput>, theme: PaletteTheme): string {
  const pattern = argStr(args?.pattern);
  const path = headerPath(args?.path);
  const glob = argStr(args?.glob);
  const limit = args?.limit;
  const invalid = invalidArg(theme);
  let text =
    theme.fg("toolTitle", theme.bold("grep")) +
    " " +
    (pattern === null ? invalid : theme.fg("accent", `/${pattern || ""}/`)) +
    theme.fg("toolOutput", ` in ${path === null ? invalid : path}`);
  if (glob) text += theme.fg("toolOutput", ` (${glob})`);
  if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
  return text;
}

/** A parsed hit line: the file/line prefix vs the content. */
interface HitLine {
  /** The `file:line:` or `file-line-` prefix. */
  prefix: string;
  /** The content after the prefix. */
  content: string;
  /** Whether this is a context line (dim) rather than a hit. */
  isContext: boolean;
}

/**
 * Parse one grep output line into prefix + content. Hit lines look like
 * `path:12: content`; context lines like `path-12- content` (the SDK's
 * formatBlock always emits the trailing space after the separator).
 *
 * Context-line disambiguation: filenames may themselves contain `-N- `
 * (issue-123- fix.ts) and so may content (see issue-5- notes). Candidates
 * scan left to right; the first whose prefix looks like a path (contains
 * "." or "/") wins, falling back to the first candidate when none does —
 * that matches the SDK's real emission (path first) far more often than
 * either a lazy or a greedy single regex.
 *
 * @param line - The raw output line.
 * @returns The parsed line, or null when the line doesn't match either form.
 */
export function parseHitLine(line: string): HitLine | null {
  const hit = line.match(/^(.+?):(\d+): (.*)$/);
  if (hit)
    return {
      prefix: inertText(`${hit[1]}:${hit[2]}:`),
      content: inertText(hit[3]),
      isContext: false,
    };
  const ctxRe = /-(\d+)- /g;
  // The prefix excludes the separator's trailing space (render adds one
  // back), matching the hit-line prefix shape `path:12:`.
  let candidate: RegExpExecArray | null;
  let fallback: RegExpExecArray | null = null;
  while ((candidate = ctxRe.exec(line)) !== null) {
    const prefix = line.slice(0, candidate.index);
    if (/[./]/.test(prefix)) {
      return {
        prefix: inertText(line.slice(0, candidate.index + candidate[0].length - 1)),
        content: inertText(line.slice(candidate.index + candidate[0].length)),
        isContext: true,
      };
    }
    fallback ??= candidate;
  }
  if (fallback) {
    return {
      prefix: inertText(line.slice(0, fallback.index + fallback[0].length - 1)),
      content: inertText(line.slice(fallback.index + fallback[0].length)),
      isContext: true,
    };
  }
  return null;
}

/**
 * Build the grep wrapper around `origGrep`.
 *
 * @param origGrep - The SDK grep tool to wrap.
 * @param services - Assembly services.
 * @returns The wrapped tool.
 */
export function createGrepWrapper(
  origGrep: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  // The call header renders via the SDK's own formatting (the factory's
  // delegation seam — no renderCall override); renderResult reads the
  // settled args directly from ctx.args (the SDK's documented pattern:
  // args are present every frame, live and restored alike).
  return createToolWrapper(origGrep, services, {
    renderShell: "default",
    // The call header is ours now (mirrors the SDK's formatGrepCall —
    // pattern / path / glob / limit); the SDK's render-utils helpers (str,
    // shortenPath, invalidArgText) are three lines each, copied here so
    // the header owns its gap without a deep import the package map
    // forbids.
    renderCall: ({ text, view, ctx, renderArgs }) => {
      const { piTheme: theme } = view;
      const args = argsOf<GrepToolInput>(renderArgs);
      renderHeaderLine({
        text,
        prefix: "gh",
        view,
        ctx,
        services,
        body: formatGrepCall(args, theme),
      });
      return text;
    },
    renderResult: ({ text, view, ctx, result, options, tookMs }) => {
      const { palette, piTheme: theme } = view;
      // Inert at intake (ADR 0004): the grep result carries raw file
      // bytes, and EVERY downstream surface — the placeholder's first
      // frame, the fallback, the plain rendering, the highlighted swap —
      // must see neutralized text. The derivation (inert + split +
      // fingerprint) is memoized on the result object's identity: a
      // stable result costs one lookup per trigger frame.
      const derive = outputMemoOf(ctx.state);
      const derived = derive(result);
      const { output, lines } = derived;
      // The pattern/flags ride the styled closure (the swap key's stamps
      // cover the content, palette, footer, expand and streaming states —
      // the args are settled per the SDK contract, so they need no stamp).
      const callArgs = argsOf<GrepToolInput>(ctx.args);
      const pattern = callArgs.pattern ?? "";
      const flags = {
        literal: callArgs.literal === true,
        ignoreCase: callArgs.ignoreCase === true,
      };
      const pending = resultStreaming(ctx);
      return assembleOutputBody({
        text,
        prefix: "g",
        lines,
        isEmpty: !output.trim(),
        budget: COLLAPSED_LINES.grep,
        derived,
        paletteIdentity: palette.identity,
        tookMs,
        expanded: options.expanded,
        streaming: pending,
        notice: derived.notice,
        theme,
        ctx,
        // Streaming frames skip highlighting entirely (the plain form is
        // the placeholder AND the frame); the settled frame re-renders
        // once through renderHighlighted and populates the cache.
        renderStyled: async (shownLines, tail, hidden) => {
          if (pending) return joinBodyTail(renderPlainOutput(shownLines, theme), tail, hidden);
          const highlighted = await renderHighlighted({
            lines: shownLines,
            pattern,
            flags,
            view,
          });
          return joinBodyTail(highlighted, tail, hidden);
        },
      });
    },
  });
}

/**
 * One member line of a grep file run — consecutive output lines from one
 * file are highlighted as one block so the grammar state flows across
 * lines (a template string or block comment spanning several hits colors
 * consistently) and the highlight cache holds one entry per file instead
 * of one per line (a large grep would otherwise flush the whole LRU).
 */
interface FileRunMember {
  /** The line's index in the overall grep output (reassembling order). */
  index: number;
  /**
   * The line's text (pre-highlight; the highlighted form rides along at
   * render time).
   */
  content: string;
  /** The parsed hit — supplies the plain prefix (path/number) segments. */
  hit: HitLine;
}

/**
 * Split a run into chunks whose joined text stays under `maxChars`, cutting
 * only at line boundaries.
 *
 * @param run - The run to chunk.
 * @param maxChars - The character budget per chunk.
 * @returns The chunks (each a non-empty member slice).
 */
function chunkRun(run: FileRunMember[], maxChars: number): FileRunMember[][] {
  const chunks: FileRunMember[][] = [];
  let current: FileRunMember[] = [];
  let chars = 0;
  for (const member of run) {
    const size = member.content.length + 1; // +1 for the join newline
    if (current.length > 0 && chars + size > maxChars) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(member);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The renderHitLine inputs. */
export interface RenderHitLineOptions {
  /** The parsed line. */
  hit: HitLine;
  /** The line content, highlighted or plain. */
  content: string;
  /** The grep pattern source. */
  pattern: string;
  /** The grep flags (literal / ignoreCase). */
  flags: MatchFlags;
  /** The pi theme. */
  theme: PaletteTheme;
  /** The palette. */
  palette: DiffPalette;
}

/**
 * Render one grep output line: muted/dim prefix, content with pattern
 * emphasis over its own fg.
 *
 * @param options - The line's inputs.
 * @returns The rendered line.
 */
export function renderHitLine(options: RenderHitLineOptions): string {
  const { hit, content, pattern, flags, theme, palette } = options;
  const emphasis = accentEmphasis(theme);
  // The content's base fg: hit lines read as tool output, context lines
  // dim (the highlight paths get this for free — every token span carries
  // its own fg; plain-text lines must open it explicitly, and the
  // emphasis wrap must re-open it after each match's RESET).
  const baseFg = hit.isContext ? palette.fgDim : theme.getFgAnsi("toolOutput");
  const emphasized = pattern ? emphasize({ content, pattern, flags, emphasis, baseFg }) : content;
  // Hit prefixes render muted: getFgAnsi (the escape alone — fg() with empty
  // text is a visual no-op, open+reset cancel out). Context prefixes dim.
  const prefixStyle = hit.isContext ? palette.fgDim : theme.getFgAnsi("muted");
  // Toolbox output: channel-scoped closes only — palette.rowReset would
  // re-open the diff canvas (a diff-row concept), and a full RESET would
  // kill pi's line-level frame canvas and expose the terminal default
  // behind the row tail (the tool-ls rule).
  return `${prefixStyle}${hit.prefix} ${baseFg}${emphasized}${SEQ_FG_DEFAULT}`;
}

/** The renderHighlighted inputs. */
interface RenderHighlightedOptions {
  /** The output lines. */
  lines: readonly string[];
  /** The grep pattern source (emphasis). */
  pattern: string;
  /** The grep flags (literal / ignoreCase). */
  flags: MatchFlags;
  /** The frame's view (the highlight entry; palette/theme ride along). */
  view: RenderView;
}

/**
 * The highlighted rendering: same-file lines merge into one highlight
 * block per file — grammar state flows across lines, so the cache holds
 * one entry per file, not per line. Pattern emphasis applies per line;
 * prefixes stay muted and context prefixes dim.
 *
 * @param options - The render inputs.
 * @returns The rendered text (async — highlighting per file).
 */
async function renderHighlighted(options: RenderHighlightedOptions): Promise<string> {
  const { lines, pattern, flags, view } = options;
  const { palette, piTheme: theme } = view;
  // Parse pass: every line classified; the file's language resolved once.
  const langByFile = new Map<string, BundledLanguage | undefined>();
  const parsed = lines.map((line) => {
    const hit = parseHitLine(line);
    if (!hit) return null;
    const file = hit.prefix.replace(/[:-]\d+[:-]$/, "");
    // has(), not get() — undefined IS a cached value here (a file with no
    // language); a get()-undefined check would re-run detectLanguage for
    // every one of its lines.
    if (!langByFile.has(file)) {
      langByFile.set(file, detectLanguage(file));
    }
    const lang = langByFile.get(file);
    return { hit, file, lang };
  });

  const rendered: string[] = Array.from({ length: lines.length });
  let i = 0;
  while (i < lines.length) {
    const entry = parsed[i];
    if (!entry) {
      rendered[i] = theme.fg("toolOutput", lines[i] ?? "");
      i++;
      continue;
    }
    if (!entry.lang) {
      rendered[i] = renderHitLine({
        hit: entry.hit,
        content: entry.hit.content,
        pattern,
        flags,
        theme,
        palette,
      });
      i++;
      continue;
    }
    // Collect the run: consecutive lines from the same file (hit and
    // context lines alike — both belong to the file's grammar).
    const members: FileRunMember[] = [];
    const file = entry.file;
    while (i < lines.length && parsed[i]?.file === file && parsed[i]?.lang) {
      const next = parsed[i];
      if (next) members.push({ index: i, content: next.hit.content, hit: next.hit });
      i++;
    }
    for (const chunk of chunkRun(members, MAX_HL_CHARS)) {
      const hlLines = await view.highlight({
        code: chunk.map((m) => m.content).join("\n"),
        language: entry.lang,
      });
      for (let k = 0; k < chunk.length; k++) {
        const member = chunk[k];
        if (!member) continue;
        rendered[member.index] = renderHitLine({
          hit: member.hit,
          content: hlLines[k] ?? member.content,
          pattern,
          flags,
          theme,
          palette,
        });
      }
    }
  }
  return rendered.join("\n");
}
