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
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import type {
  ReadToolInput,
  ToolDefinition,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getReadmePath,
} from "@earendil-works/pi-coding-agent";

import { inertText } from "#src/core/ansi.ts";
import { SEQ_BOLD, SEQ_BOLD_OFF } from "#src/core/escapes.ts";
import { linesOf } from "#src/core/lines.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { RenderTheme, ResolvedTheme } from "#src/theme/scheme.ts";
import { memoSeedText, needsSeed, type SeedTextMemo } from "#src/theme/seed.ts";

import { assembleOutputBody } from "./output-assembly.ts";
import { toPosixPath } from "./paths.ts";
import { numberedRows } from "./row-frame.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { expandKeyHint, joinBodyTail } from "./tool-output.ts";
import { argsOf, argStr, headerPathLink, type ToolServices } from "./tool-services.ts";

/** Compact resource basenames that collapse to a bare label. */
const COMPACT_RESOURCE_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

/**
 * Mirror the SDK's compact-read classification (SKILL.md → [skill],
 * pi docs → docs label, resource basenames → bare label). Paths resolve
 * against the call cwd, following renderers/read.js except where noted
 * below (docs breadcrumb tint, expanded-state classification; accepted
 * deviations: no @-prefix/unicode-space normalization, accent "." for
 * the empty-path fallback where the SDK renders "...").
 *
 * @param raw - The raw path arg.
 * @param cwd - The session working directory.
 * @returns The classification, or undefined for a full header.
 */
function classifyCompactRead(
  raw: string,
  cwd: string,
): { kind: "skill" | "docs" | "resource"; label: string } | undefined {
  if (raw === "") return undefined;
  const absolute = isAbsolute(raw) ? raw : resolvePath(cwd, raw);
  const fileName = basename(absolute);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: basename(dirname(absolute)) || fileName };
  }
  // The pi-docs classification (renderers/read.js, byte for byte): paths
  // under the pi package root's README/docs/examples collapse to a label.
  const packageRoot = dirname(getReadmePath());
  const rel = relative(resolvePath(packageRoot), resolvePath(absolute));
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    const label = toPosixPath(rel);
    if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
      return { kind: "docs", label };
    }
  }
  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    const relPath = relative(cwd, absolute);
    return {
      kind: "resource",
      label:
        relPath === "" || relPath === ".." || relPath.startsWith(`..${sep}`)
          ? toPosixPath(absolute)
          : toPosixPath(relPath),
    };
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
 * The read call header: the SDK's formatReadCall/formatCompactReadCall
 * shape (toolTitle name, path or compact label, warning range), with one
 * deliberate tint departure: the docs breadcrumb dims the directory and
 * accents only the basename (the SDK accents the whole label).
 *
 * @param args - The settled read args.
 * @param theme - The pi theme.
 * @param cwd - The session working directory.
 * @param expanded - Whether the row is expanded (compact labels collapse only).
 * @returns The header row (no trailing gap — the caller owns it).
 */
function formatReadCall(
  args: Partial<ReadToolInput>,
  theme: RenderTheme,
  cwd: string,
  expanded: boolean,
): string {
  const raw = argStr(args?.path);
  const range = formatReadLineRange(args, theme);
  const expandHint = ` (${expandKeyHint(theme)}`;
  if (!expanded && raw !== null) {
    const compact = classifyCompactRead(raw, cwd);
    if (compact?.kind === "skill") {
      return (
        theme.fg("customMessageLabel", `${SEQ_BOLD}[skill]${SEQ_BOLD_OFF} `) +
        theme.fg("customMessageText", compact.label) +
        range +
        expandHint +
        ")"
      );
    }
    if (compact) {
      return (
        `${theme.fg("toolTitle", theme.bold(`read ${compact.kind}`))} ` +
        theme.fg("accent", compact.label) +
        range +
        expandHint +
        ")"
      );
    }
  }
  const pathDisplay = headerPathLink(raw, theme, cwd);
  return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${range}`;
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
      formatCallBody: (renderArgs, theme, ctx) =>
        formatReadCall(argsOf<ReadToolInput>(renderArgs), theme, ctx.cwd, ctx.expanded),
    },
    renderResult: ({ text, view, ctx, result, options, tookMs }) => {
      const { theme, scheme } = view;
      // Image results pass through as plain text (the note the SDK
      // leaves in content) — pigment never paints non-text blocks.
      const content = (result.content ?? []) as Array<{ type?: string; text?: string }>;
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
      // under the header — "did I read the right file" at a glance
      // (compact skill/docs labels included — the label names it, the
      // preview proves it). No seed, no notice, no Took: a preview is
      // a preview. Error frames never reach here (the factory
      // intercepts them).
      if (!options.expanded) {
        const previewLines = linesOf(output);
        return assembleOutputBody({
          text,
          prefix: "r",
          lines: previewLines,
          isEmpty: previewLines.length === 0,
          derived: {
            output,
            lines: previewLines,
            entries: previewLines.filter((line) => line !== ""),
            notice: "",
            hash: `fold:${toPosixPath(raw)}:${output.length}`,
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
              const absolute = isAbsolute(raw) ? raw : resolvePath(ctx.cwd, raw);
              return readFileSync(absolute, "utf-8");
            })
          : undefined;
      const truncation = (result.details as { truncation?: TruncationResult } | undefined)
        ?.truncation;
      const filePath = toPosixPath(raw);
      const contentLines = linesOf(output);
      // A single full block, never collapsed (the native renderer shows
      // all lines expanded, with the truncation notice as the only
      // footer) — no budget passed.
      return assembleOutputBody({
        text,
        prefix: "r",
        lines: contentLines,
        isEmpty: contentLines.length === 0,
        derived: {
          output,
          lines: contentLines,
          entries: contentLines.filter((line) => line !== ""),
          notice: "",
          hash: `${filePath}:${offset ?? 0}:${output.length}`,
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
