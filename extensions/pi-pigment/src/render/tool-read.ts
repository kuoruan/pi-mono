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

import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AgentToolResult,
  ReadToolInput,
  ToolDefinition,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

import { expandTabs, inertText } from "#src/core/ansi.ts";
import { linesOf } from "#src/core/lines.ts";
import type { FileCodeBlock } from "#src/theme/highlight.ts";
import { detectLanguage } from "#src/theme/language.ts";
import type { RenderTheme, ResolvedTheme } from "#src/theme/scheme.ts";
import { memoSeedText, needsSeed, type SeedTextMemo } from "#src/theme/seed.ts";

import { assembleOutputBody } from "./output-assembly.ts";
import { expandHome, readDecorativeText, resolveToolPath, toPosixPath } from "./paths.ts";
import { numberedRows } from "./row-frame.ts";
import type { FrameView } from "./session.ts";
import { createToolWrapper } from "./tool-factory.ts";
import { type DerivedOutput, expandKeyHint, joinBodyTail } from "./tool-output.ts";
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
  const fileName = basename(resolveToolPath(cwd, raw)).toLowerCase();
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
 * body mask share this verdict within one assembly (the header and the
 * body each assemble separately, so each frame judges at most twice —
 * once per slot — never per line).
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
  const absolute = resolveToolPath(cwd, raw);
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

/** The read styled-body inputs: the folded/expanded pair varies only these. */
interface ReadStyledInput {
  /** The windowed lines (single source — block.code derives from it). */
  shown: string[];
  /** The tail block. */
  tail: string;
  /** The hidden count. */
  hidden: number;
  /** The render width. */
  width: number;
  /** Whether the result is an image note (no gutter, no highlight). */
  isImage: boolean;
  /**
   * The highlight block minus code (seed context rides here for offset
   * slices; code always joins from shown, so the two cannot diverge).
   */
  block: Omit<FileCodeBlock, "code">;
  /** The gutter's first line number. */
  startLine: number;
}

/**
 * The read styled body: image notes pass through plain, file text
 * highlights then takes the gutter. One choreography behind both the
 * folded preview and the expanded body.
 *
 * @param input - The styled-body inputs (see ReadStyledInput).
 * @param view - The session view (highlight).
 * @param scheme - The resolved theme (gutter).
 * @returns The settled body.
 */
async function renderReadStyled(
  input: ReadStyledInput,
  view: FrameView,
  scheme: ResolvedTheme,
): Promise<string> {
  const { shown, tail, hidden, width, isImage, block, startLine } = input;
  const code = shown.join("\n");
  if (isImage) return joinBodyTail(code, tail, hidden);
  const highlighted = await view.highlight({ ...block, code });
  return joinBodyTail(
    withLineNumbers(highlighted, scheme, startLine, width).join("\n"),
    tail,
    hidden,
  );
}

/**
 * The read line-range suffix (:start-end), warning-colored per the SDK.
 *
 * @param args - The settled read args.
 * @param theme - The pi theme.
 * @returns The suffix, or "" without offset/limit.
 */
function formatReadLineRange(args: Partial<ReadToolInput>, theme: RenderTheme): string {
  // Strict tool schemas make models send null for omitted optionals
  // (the SDK's own read renderer reads them with `== null`).
  if (args?.offset == null && args?.limit == null) return "";
  const start = args.offset ?? 1;
  const end = args.limit !== undefined ? start + args.limit - 1 : "";
  return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}

/**
 * A display path with the breadcrumb tint: the directory dims (muted),
 * only the basename accents — a long path reads as its file. Shared
 * by the docs label and the plain read path.
 *
 * @param display - The posix display path.
 * @param theme - The pi theme.
 * @returns The styled path.
 */
function accentBasename(display: string, theme: RenderTheme): string {
  const slash = display.lastIndexOf("/");
  if (slash < 0) return theme.fg("accent", display);
  return (
    theme.fg("muted", display.slice(0, slash + 1)) + theme.fg("accent", display.slice(slash + 1))
  );
}

/**
 * The read plain path: the breadcrumb tint hyperlinked whole.
 * Read-local — ls keeps its single-accent parity shape
 * (headerPathLink untouched).
 *
 * @param raw - The stringified `path` arg.
 * @param theme - The pi theme.
 * @param cwd - The session working directory.
 * @returns The styled path.
 */
function headerPathSegments(raw: string | null, theme: RenderTheme, cwd: string): string {
  if (raw === null) return invalidArg(theme);
  const styled = accentBasename(headerPath(raw) ?? ".", theme);
  if (!getCapabilities().hyperlinks) return styled;
  return hyperlink(styled, pathToFileURL(resolve(cwd, expandHome(raw) || ".")).href);
}

/** The read masked-text derivation: the text plus its image mark. */
interface ReadMasked {
  /** The masked, tab-expanded text (tail notices lifted). */
  masked: string;
  /** Whether the result carries an image block (note, not file text). */
  isImage: boolean;
  /** The lifted user-limit notice (`[N more lines…]`), or "" when none. */
  notice: string;
}

/**
 * Lift the SDK's tail notice lines out of the masked text (the
 * find/grep/ls contract — notices ride the footer, never a guttered
 * body row): the user-limit continuation returns as the footer notice,
 * the truncation `[Showing lines…]` drops (the footer already carries
 * the synthesized `[Truncated:…]`). No prose is matched and no disk is
 * read — the user-limit branch is recognized by the output's own shape:
 * the SDK emits exactly `limit` content rows before the notice (when
 * the file ends within the window it emits fewer rows and no notice),
 * so a bracketed tail row over a full window is the continuation. The
 * only blind spot is `limit` landing exactly on the file's last line
 * with a bracketed final row — the row moves to the footer instead of
 * the body. Upstream may reword, rename, or translate the prose —
 * only a shape change breaks this.
 *
 * @param masked - The masked text.
 * @param truncated - Whether details carry a truncation fact.
 * @param limit - The requested line count (undefined → no user-limit notice possible).
 * @returns The body text + the footer notice ("" when none lifted).
 */
function liftReadNotice(
  masked: string,
  truncated: boolean,
  limit: number | undefined,
): { body: string; notice: string } {
  const lines = linesOf(masked);
  const last = lines[lines.length - 1];
  if (last === undefined || lines.length < 2) return { body: masked, notice: "" };
  if (!last.startsWith("[") || !last.endsWith("]")) return { body: masked, notice: "" };
  const body = masked.slice(0, masked.lastIndexOf(last)).trimEnd();
  // The SDK's user-limit notice follows a full window (limit rows);
  // the truncation branch is fact-guarded (details), not counted.
  if (limit != null && limit > 0 && linesOf(body).length === limit) {
    return { body, notice: last };
  }
  if (truncated) return { body, notice: "" };
  return { body: masked, notice: "" };
}

/** The read masked-text derivation inputs: one frame's derive context. */
interface ReadMaskedInput {
  /** The row-state memo (the derivation cell's home). */
  memo: ReadRowMemo;
  /** The settled result. */
  result: AgentToolResult<unknown>;
  /** The path:offset key. */
  key: string;
  /** The raw path arg (masking scope). */
  raw: string;
  /** The session working directory. */
  cwd: string;
  /** The requested line count (undefined → no user-limit notice possible). */
  limit: number | undefined;
}

/**
 * Derive the masked text for one frame: result-identity + path:offset
 * memoized in the row state (the grep/find/ls outputMemoOf seam is
 * result-identity keyed — but read's derive inputs are THEMSELVES
 * derived per frame, so the identity never stabilizes there). Image
 * notes pass through as plain text (pigment never paints non-text
 * blocks); file bytes go inert at intake (ADR 0004), secrets mask
 * same-line-count so the gutter stays aligned, tabs expand for write
 * parity.
 *
 * @param input - The derive inputs (see ReadMaskedInput).
 * @returns The masked derivation.
 */
function deriveReadMasked(input: ReadMaskedInput): ReadMasked {
  const { memo, result, key, raw, cwd, limit } = input;
  const cached = memo.readDerive;
  if (cached && cached.result === result && cached.key === key) {
    return { masked: cached.masked, isImage: cached.isImage, notice: cached.notice };
  }
  const content = result.content ?? [];
  const isImage = content.some((block) => block.type === "image");
  const output = inertText(
    content
      .filter((block) => block.type === "text" || block.type === undefined)
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("")
      .replaceAll("\r", ""),
  ).replace(/\n$/, "");
  const truncated =
    ((result.details as ReadResultDetails | undefined)?.truncation?.truncated ?? false) === true;
  const lifted = liftReadNotice(
    expandTabs(surfaceSecrets(raw, cwd, output).masked),
    truncated,
    limit,
  );
  memo.readDerive = { result, key, masked: lifted.body, isImage, notice: lifted.notice };
  return { masked: lifted.body, isImage, notice: lifted.notice };
}

/**
 * The offset slice's seed block: file text before the slice seeds
 * embedded grammars (the edit precedent — one path per row, staleness
 * is display-only), gated to embedded languages so plain reads never
 * pay the disk. readDecorativeText never throws; memoSeedText wants
 * the miss as a throw (it memoizes the null).
 *
 * @param memo - The row-state memo.
 * @param raw - The raw path arg.
 * @param cwd - The session working directory.
 * @param offset - The slice's start line.
 * @returns The seed block (filePath only when unseeded).
 */
function readSeedBlock(
  memo: ReadRowMemo,
  raw: string,
  cwd: string,
  offset: number | undefined,
): Omit<FileCodeBlock, "code"> {
  const filePath = toPosixPath(raw);
  const seedText =
    offset !== undefined && needsSeed(detectLanguage(filePath))
      ? memoSeedText(memo, () => {
          const seedPath = resolveToolPath(cwd, raw);
          const fileText = readDecorativeText(seedPath);
          if (fileText === undefined) throw new Error(`unreadable seed: ${seedPath}`);
          return fileText;
        })
      : undefined;
  return seedText !== undefined && offset !== undefined
    ? { filePath, context: { text: seedText, startLine: offset } }
    : { filePath };
}

/** The read result details (only the truncation the header/footer reads). */
type ReadResultDetails = { truncation?: TruncationResult };

/**
 * The read derivation as a DerivedOutput: masked text + line views +
 * the identity hash. Folded and expanded differ only in the hash
 * namespace (fold: vs path:offset) — the shape is one.
 *
 * @param masked - The masked text.
 * @param lines - The content lines.
 * @param hash - The identity hash.
 * @returns The derived output.
 */
function readDerived(masked: string, lines: string[], hash: string): DerivedOutput {
  return {
    output: masked,
    lines,
    entries: lines.filter((line) => line !== ""),
    notice: "",
    hash,
  };
}

/** The memoized masked derivation (isImage + notice ride along — a cache hit keeps both). */
interface ReadDerivation {
  /** The result identity (a stable result costs one lookup per frame). */
  result: object;
  /** The path:offset key. */
  key: string;
  /** The masked text (tail notices lifted). */
  masked: string;
  /** Whether the result carries an image block (note, not file text — no gutter). */
  isImage: boolean;
  /** The lifted user-limit notice ("" when none). */
  notice: string;
}

/**
 * The read row-state memo: the seed memo plus the masked-derivation cell
 * (result identity + path:offset key — an unchanged frame reuses the
 * masked text instead of re-running surfaceSecrets per render; limit
 * rides the result identity, so it needs no key slot of its own).
 */
type ReadRowMemo = SeedTextMemo & {
  /** The memoized masked derivation. */
  readDerive?: ReadDerivation;
};

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
      // Model-supplied label — inert, like the path display.
      const label = inertText(compact.label);
      return theme.fg("accent", theme.bold(`✦ ${label}`)) + theme.fg("muted", " skill");
    }
    if (compact) {
      // `[pi]` names the source — without it an SDK README is
      // indistinguishable from a project file.
      const origin = compact.kind === "docs" ? theme.fg("muted", "[pi] ") : "";
      const clean = inertText(compact.label);
      const label =
        compact.kind === "docs" ? accentBasename(clean, theme) : theme.fg("accent", clean);
      return `${theme.fg("toolTitle", theme.bold(`read ${compact.kind}`))} ` + origin + label;
    }
  }
  // Read-local breadcrumb (ls keeps its single-accent shape).
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
      const { scheme } = view;
      const args = argsOf<ReadToolInput>(ctx.args);
      const raw = argStr(args?.path) ?? "";
      const memoState = ctx.state as ReadRowMemo;
      const {
        masked,
        isImage: isImageResult,
        notice: moreLinesNotice,
      } = deriveReadMasked({
        memo: memoState,
        result,
        key: `${toPosixPath(raw)}:${args?.offset ?? 0}`,
        raw,
        cwd: ctx.cwd,
        limit: args?.limit,
      });
      const contentLines = linesOf(masked);
      // Folded shows the preview only: no seed, no notice, no Took.
      if (!options.expanded) {
        return assembleOutputBody({
          text,
          prefix: "r",
          lines: contentLines,
          isEmpty: masked === "",
          derived: readDerived(masked, contentLines, `fold:${toPosixPath(raw)}:${masked.length}`),
          view,
          budget: READ_FOLDED_LINES,
          expanded: false,
          ctx,
          renderStyled: {
            widthAware: true,
            render: (shown, tail, hidden, width) =>
              renderReadStyled(
                {
                  shown,
                  tail,
                  hidden,
                  width,
                  isImage: isImageResult,
                  block: { filePath: toPosixPath(raw) },
                  startLine: args?.offset ?? 1,
                },
                view,
                scheme,
              ),
          },
        });
      }
      const offset = args?.offset;
      const block = readSeedBlock(memoState, raw, ctx.cwd, offset);
      const truncation = (result.details as ReadResultDetails | undefined)?.truncation;
      const filePath = toPosixPath(raw);
      // A single full block, never collapsed (the native renderer shows
      // all lines expanded, with the truncation notice as the only
      // footer) — no budget passed.
      return assembleOutputBody({
        text,
        prefix: "r",
        lines: contentLines,
        isEmpty: masked === "",
        derived: readDerived(masked, contentLines, `${filePath}:${offset ?? 0}:${masked.length}`),
        view,
        tookMs,
        expanded: true,
        notice: truncation?.truncated
          ? formatTruncationNotice(truncation)
          : moreLinesNotice || undefined,
        ctx,
        renderStyled: {
          widthAware: true,
          render: (shown, tail, hidden, width) =>
            renderReadStyled(
              {
                shown,
                tail,
                hidden,
                width,
                isImage: isImageResult,
                block,
                startLine: offset ?? 1,
              },
              view,
              scheme,
            ),
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
