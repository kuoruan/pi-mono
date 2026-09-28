/**
 * The read tool wrapper: execution delegates to the SDK's read tool (via
 * the tool-wrapper factory); rendering keeps the SDK's header shape
 * (compact skill/docs labels, path + line-range suffix) on pigment's
 * header line, and paints the expanded body through the session's Shiki
 * highlight — the file-sourced spelling, so detection and seeding ride
 * along. Image results pass through as plain text (the note the SDK
 * leaves in content) — pigment never paints non-text blocks, and the
 * SDK's imageFallback size line is not rendered either.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ReadToolInput,
  ToolDefinition,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

import { inertText } from "#src/core/ansi.ts";
import { linesOf } from "#src/core/lines.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { RenderTheme, ResolvedTheme } from "#src/theme/scheme.ts";
import { memoSeedText, needsSeed, type SeedTextMemo } from "#src/theme/seed.ts";

import { assembleOutputBody } from "./output-assembly.ts";
import { expandHome, toPosixPath } from "./paths.ts";
import { numberedRows } from "./row-frame.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { expandKeyHint, joinBodyTail } from "./tool-output.ts";
import { argsOf, argStr, headerPath, invalidArg, type ToolServices } from "./tool-services.ts";

/** Compact resource basenames that collapse to a bare label. */
const COMPACT_RESOURCE_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

/** Lockfiles: machine-generated version pins, not reading material. */
const GENERATED_LOCK_FILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

/**
 * Whether the path names a secret-bearing file (`.env*`, `*.pem`/`*.key`,
 * `*credential*` — basename, lowercased). Conservative by design:
 * `.env.example`/`.envrc` over-flag as noise, never under-flag.
 * Classification only — body masking covers dotenv assignment lines;
 * JSON (quoted keys) and PEM blocks (base64) get the banner alone.
 *
 * @param raw - The raw path arg.
 * @param cwd - The session working directory.
 * @returns True when the file is secret-bearing.
 */
function isSensitiveRead(raw: string, cwd: string): boolean {
  if (raw === "") return false;
  const fileName = basename(isAbsolute(raw) ? raw : resolve(cwd, raw)).toLowerCase();
  return (
    fileName.startsWith(".env") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key") ||
    fileName.includes("credential")
  );
}

/**
 * The secret surfacing for one read: the verdict plus the masked text.
 * One call judges once and masks once — the suffix banner and the
 * body mask share this verdict, never classify twice per frame.
 */
interface SecretSurfacing {
  /** True for secret-bearing basenames. */
  sensitive: boolean;
  /** The masked text (identical to input when not sensitive). */
  masked: string;
}

/**
 * Surface secrets for a read: judge the path, mask the text. The mask
 * keeps the line count (the numbers gutter stays aligned).
 *
 * @param raw - The raw path arg.
 * @param cwd - The session working directory.
 * @param output - The file text (post-inert, pre-highlight).
 * @returns The verdict + masked text.
 */
function surfaceSecrets(raw: string, cwd: string, output: string): SecretSurfacing {
  const sensitive = isSensitiveRead(raw, cwd);
  return { sensitive, masked: sensitive ? maskSecretValues(output) : output };
}

/**
 * Mask dotenv assignment values line by line (key names stay readable —
 * the agent needs them to work; values collapse to a prefix + `****`).
 * Comment lines and empty values pass through untouched.
 *
 * @param output - The file text (post-inert, pre-highlight).
 * @returns The masked text (same line count — the gutter stays aligned).
 */
function maskSecretValues(output: string): string {
  return output
    .split("\n")
    .map((line) =>
      line.replace(
        /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*)(.+?)\s*$/,
        (_match, head: string, value: string) =>
          `${head}${value.length <= 4 ? "****" : `${value.slice(0, 2)}****`}`,
      ),
    )
    .join("\n");
}

/**
 * A cwd-relative label, or the absolute path when outside the cwd
 * (the resource branch's guard, shared with lockfiles — one rule
 * for every collapsed label).
 *
 * @param absolute - The resolved absolute path.
 * @param cwd - The session working directory.
 * @returns The label.
 */
function collapseLabel(absolute: string, cwd: string): string {
  const relPath = relative(cwd, absolute);
  return relPath === "" || relPath === ".." || relPath.startsWith(`..${sep}`)
    ? toPosixPath(absolute)
    : toPosixPath(relPath);
}

/** The path context every read header decision shares (cwd + pi install root). */
interface ReadPathContext {
  /** The session working directory. */
  cwd: string;
  /** The session's pi install root (no per-frame fs walk). */
  piRoot: string;
}

/** The full header input: path context + frame state + settled args. */
interface ReadHeaderInput extends ReadPathContext {
  /** The settled read args. */
  args: Partial<ReadToolInput>;
  /** The pi theme. */
  theme: RenderTheme;
  /** Whether the row is expanded (compact labels collapse only). */
  expanded: boolean;
}

/** A compact read label: the collapsed kind + its display text. */
interface CompactReadLabel {
  /** The collapsed kind (skill, pi-docs, resource, or lockfile). */
  kind: "skill" | "docs" | "resource" | "generated";
  /** The display label (skill name, docs relpath, or resource path). */
  label: string;
}

/**
 * Mirror the SDK's compact-read classification (SKILL.md → [skill],
 * pi docs → docs label, resource basenames → bare label). Paths resolve
 * against the call cwd, following renderers/read.js except where noted
 * below (docs breadcrumb tint, expanded-state classification; accepted
 * deviations: no @-prefix/unicode-space normalization, accent "." for
 * the empty-path fallback where the SDK renders "...").
 *
 * @param input - The raw path + shared path context.
 * @returns The classification, or undefined for a full header.
 */
function classifyCompactRead(
  input: ReadPathContext & { raw: string },
): CompactReadLabel | undefined {
  const { raw, cwd, piRoot } = input;
  if (raw === "") return undefined;
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const fileName = basename(absolute);
  // Deliberate parity departure: skill folds case-insensitively while
  // resource keeps its two-spelling enumeration (AGENTS.md/AGENTS.MD)
  // — filesystems disagree on case, the skill label must not.
  if (fileName.toLowerCase() === "skill.md") {
    return { kind: "skill", label: basename(dirname(absolute)) || fileName };
  }
  // The pi-docs classification (renderers/read.js, byte for byte): paths
  // under the pi package root's README/docs/examples collapse to a label.
  const rel = relative(resolve(piRoot), resolve(absolute));
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    const label = toPosixPath(rel);
    if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
      return { kind: "docs", label };
    }
  }
  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: "resource", label: collapseLabel(absolute, cwd) };
  }
  if (GENERATED_LOCK_FILES.has(fileName)) {
    return { kind: "generated", label: collapseLabel(absolute, cwd) };
  }
  return undefined;
}

/** The folded preview's line budget ("did I read the right file"). */
const READ_FOLDED_LINES = 3;

/**
 * Paint the read numbers gutter: the shared numberedRows assembly
 * over highlighted lines, AFTER highlighting (the gutter must not
 * enter the Shiki token stream).
 *
 * @param lines - The highlighted lines.
 * @param scheme - The resolved scheme.
 * @param startLine - The 1-indexed first line (the read offset, or 1).
 * @param width - The render width (the assembly seam always supplies it).
 * @returns The guttered lines.
 */
function withLineNumbers(
  lines: string[],
  scheme: ResolvedTheme,
  startLine: number,
  width: number,
): string[] {
  const numberWidth = Math.max(2, String(startLine + lines.length - 1).length);
  // The read gutter is number + one space (no sign column to budget).
  return numberedRows({
    lines,
    scheme,
    type: "read",
    startLine,
    gutter: numberWidth + 1,
    indicatorGlyph: "",
    width,
  });
}

/**
 * The read line-range suffix (:start-end), warning-colored per the SDK.
 *
 * @param args - The settled read args.
 * @param theme - The pi theme.
 * @returns The suffix, or "" without offset/limit.
 */
function formatReadLineRange(args: Partial<ReadToolInput>, theme: RenderTheme): string {
  if (args?.offset === undefined && args?.limit === undefined) return "";
  const start = args.offset ?? 1;
  const end = args.limit !== undefined ? start + args.limit - 1 : "";
  return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}

/**
 * The docs label with a breadcrumb tint: the directory dims (muted),
 * only the basename accents — a long docs/ path reads as its file.
 *
 * @param label - The posix docs label (README.md or docs/...).
 * @param theme - The pi theme.
 * @returns The styled label.
 */
function formatDocsLabel(label: string, theme: RenderTheme): string {
  const slash = label.lastIndexOf("/");
  if (slash < 0) return theme.fg("accent", label);
  return theme.fg("muted", label.slice(0, slash + 1)) + theme.fg("accent", label.slice(slash + 1));
}

/**
 * The read plain path: the docs' three-segment grammar (muted dir +
 * accent base) hyperlinked whole. Read-local — ls keeps its
 * single-accent parity shape (headerPathLink untouched).
 *
 * @param raw - The stringified `path` arg.
 * @param theme - The pi theme.
 * @param cwd - The session working directory.
 * @returns The styled path.
 */
function headerPathSegments(raw: string | null, theme: RenderTheme, cwd: string): string {
  if (raw === null) return invalidArg(theme);
  const display = headerPath(raw) ?? ".";
  const slash = display.lastIndexOf("/");
  const styled =
    slash < 0
      ? theme.fg("accent", display)
      : theme.fg("muted", display.slice(0, slash + 1)) +
        theme.fg("accent", display.slice(slash + 1));
  if (!getCapabilities().hyperlinks) return styled;
  return hyperlink(styled, pathToFileURL(resolve(cwd, expandHome(raw) || ".")).href);
}

/** A text content block (the SDK's content shape, narrowed for intake). */
type TextContentBlock = { type?: string; text?: string };

/** The read result details (only the truncation the header/footer reads). */
type ReadResultDetails = { truncation?: TruncationResult };

/**
 * The read call header body (the range rides the pinned suffix, not
 * the body): the SDK's formatReadCall/formatCompactReadCall shape
 * (toolTitle name, path or compact label), with deliberate tint
 * departures — skill folds to an accent `✦` chip, docs wear the `[pi]`
 * origin mark plus a muted-dir/accent-base breadcrumb, the plain path
 * shares that three-segment grammar, and lockfiles collapse to
 * `read generated`.
 *
 * @param input - Settled args + theme + shared path context + frame state.
 * @returns The header row (no trailing gap — the caller owns it).
 */
function formatReadCall(input: ReadHeaderInput): string {
  const { args, theme, cwd, expanded, piRoot } = input;
  const raw = argStr(args?.path);
  if (!expanded && raw !== null) {
    const compact = classifyCompactRead({ raw, cwd, piRoot });
    if (compact?.kind === "skill") {
      return theme.fg("accent", theme.bold(`✦ ${compact.label}`)) + theme.fg("muted", " skill");
    }
    if (compact) {
      // The pi-docs origin mark: SDK-space paths collapse exactly like
      // project files, so the header names the source (`[pi]`, the
      // `[skill]` chip's bracket kin) — otherwise a pi README is
      // indistinguishable from the project's. The docs label keeps its
      // breadcrumb (muted dir + accent base) behind the mark; resource
      // labels stay a single accent span.
      const origin = compact.kind === "docs" ? theme.fg("muted", "[pi] ") : "";
      const label =
        compact.kind === "docs"
          ? formatDocsLabel(compact.label, theme)
          : theme.fg("accent", compact.label);
      return `${theme.fg("toolTitle", theme.bold(`read ${compact.kind}`))} ` + origin + label;
    }
  }
  // The plain path in the docs' three-segment grammar (muted dir +
  // accent base), hyperlinked whole — read-local, so ls keeps its
  // single-accent parity shape.
  const pathDisplay = headerPathSegments(raw, theme, cwd);
  return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;
}

/**
 * The read pinned suffix: the `:offset-limit` range (state that must
 * survive truncation) plus the folded expand hint. The hint rides the
 * suffix — not the body — so the range keeps its `path:range (hint)`
 * order on every frame (the body carries no hint of its own).
 *
 * @param input - Settled args + theme + shared path context + frame state.
 * @returns The suffix (may be "").
 */
function formatReadSuffix(input: ReadHeaderInput): string {
  const { args, theme, cwd, expanded, piRoot } = input;
  const range = formatReadLineRange(args, theme);
  const raw = argStr(args?.path);
  if (!expanded && raw !== null && classifyCompactRead({ raw, cwd, piRoot }) !== undefined) {
    return `${range} (${expandKeyHint(theme)})`;
  }
  // Secret-bearing files ride the plain branch in both states (never
  // compact) — the banner shows folded and expanded alike.
  if (raw !== null && isSensitiveRead(raw, cwd)) {
    return `${range} ${theme.fg("warning", "⚠ sensitive")}`;
  }
  return range;
}

/**
 * Build the read wrapper around `origRead`.
 *
 * @param origRead - The SDK read tool to wrap (shape only — rendering is fully owned).
 * @param services - Assembly services.
 * @returns The wrapped tool.
 */
export function createReadWrapper(
  origRead: ToolDefinition,
  services: ToolServices,
): ToolDefinition {
  return createToolWrapper(origRead, services, {
    renderShell: "default",
    renderHeader: {
      prefix: "rh",
      formatCallBody: (renderArgs, theme, ctx, view) =>
        formatReadCall({
          args: argsOf<ReadToolInput>(renderArgs),
          theme,
          cwd: ctx.cwd,
          expanded: ctx.expanded,
          piRoot: view.piRoot,
        }),
      formatSuffix: (renderArgs, theme, ctx, view) =>
        formatReadSuffix({
          args: argsOf<ReadToolInput>(renderArgs),
          theme,
          cwd: ctx.cwd,
          expanded: ctx.expanded,
          piRoot: view.piRoot,
        }),
    },
    renderResult: ({ text, view, ctx, result, options, tookMs }) => {
      const { theme, scheme } = view;
      // Image results pass through as plain text (the note the SDK
      // leaves in content) — pigment never paints non-text blocks.
      const content = (result.content ?? []) as TextContentBlock[];
      // Inert at intake (ADR 0004): file bytes ride raw (ANSI logs,
      // hostile escapes); the CR strip mirrors getTextOutput.
      const output = inertText(
        content
          .filter((block) => block.type === "text" || block.type === undefined)
          .map((block) => block.text ?? "")
          .join("")
          .replaceAll("\r", ""),
      ).replace(/\n$/, "");
      const args = argsOf<ReadToolInput>(ctx.args);
      const raw = argStr(args?.path) ?? "";
      // Secret-bearing files mask dotenv values before highlight (the
      // gutter/line-count stay aligned — masking is same-line-count).
      const masked = surfaceSecrets(raw, ctx.cwd, output).masked;
      // under the header — "did I read the right file" at a glance
      // (compact skill/docs labels included — the label names it, the
      // preview proves it). No seed, no notice, no Took: a preview is
      // a preview. Error frames never reach here (the factory
      // intercepts them).
      if (!options.expanded) {
        const previewLines = linesOf(masked);
        return assembleOutputBody({
          text,
          prefix: "r",
          lines: previewLines,
          isEmpty: previewLines.length === 0,
          derived: {
            output: masked,
            lines: previewLines,
            entries: previewLines.filter((line) => line !== ""),
            notice: "",
            hash: `fold:${toPosixPath(raw)}:${masked.length}`,
          },
          schemeIdentity: scheme.identity,
          budget: READ_FOLDED_LINES,
          expanded: false,
          theme,
          ctx,
          renderStyled: async (shown, tail, hidden, width) => {
            const highlighted = await view.highlight({
              code: shown.join("\n"),
              filePath: toPosixPath(raw),
            });
            return joinBodyTail(
              withLineNumbers(highlighted, scheme, args?.offset ?? 1, width).join("\n"),
              tail,
              hidden,
            );
          },
        });
      }
      const offset = args?.offset;
      // The seed source (the edit precedent): file text before an offset
      // slice seeds embedded grammars; the memo lives in the row state
      // (one path per row, display-only staleness, self-heals next call).
      // The needsSeed gate (the edit precedent): only embedded
      // grammars consume a seed, so an offset read of a plain language
      // never pays for the disk.
      const seedState = ctx.state as SeedTextMemo;
      const seedText =
        offset !== undefined && needsSeed(detectLanguage(toPosixPath(raw)))
          ? memoSeedText(seedState, () => {
              const absolute = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
              return readFileSync(absolute, "utf-8");
            })
          : undefined;
      const truncation = (result.details as ReadResultDetails | undefined)?.truncation;
      const filePath = toPosixPath(raw);
      const contentLines = linesOf(masked);
      // A single full block, never collapsed (the native renderer shows
      // all lines expanded, with the truncation notice as the only
      // footer) — no budget passed.
      return assembleOutputBody({
        text,
        prefix: "r",
        lines: contentLines,
        isEmpty: contentLines.length === 0,
        derived: {
          output: masked,
          lines: contentLines,
          entries: contentLines.filter((line) => line !== ""),
          notice: "",
          hash: `${filePath}:${offset ?? 0}:${masked.length}`,
        },
        schemeIdentity: view.scheme.identity,
        tookMs,
        expanded: true,
        notice: truncation?.truncated ? formatTruncationNotice(truncation) : undefined,
        theme,
        ctx,
        renderStyled: async (shown, tail, hidden, width) => {
          const highlighted = await view.highlight(
            seedText !== undefined && offset !== undefined
              ? { code: shown.join("\n"), filePath, context: { text: seedText, startLine: offset } }
              : { code: shown.join("\n"), filePath },
          );
          return joinBodyTail(
            withLineNumbers(highlighted, scheme, offset ?? 1, width).join("\n"),
            tail,
            hidden,
          );
        },
      });
    },
  });
}

/**
 * The SDK's truncation notice, byte for byte (renderers/read.js).
 *
 * @param truncation - The SDK truncation record.
 * @returns The notice line.
 */
function formatTruncationNotice(truncation: TruncationResult): string {
  if (truncation.firstLineExceedsLimit) {
    return `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`;
  }
  return `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`;
}
