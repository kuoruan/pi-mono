/**
 * The session render seam: an immutable per-session value of every
 * render-derived input, plus a per-frame binder producing the derived
 * view. "A new session is a new value" — no invalidation protocol exists
 * or is needed: every memo keys on the identity of its inputs, and the
 * memos are per-session INSTANCE state, so two sessions in one process
 * cannot share or clobber each other's resolutions.
 *
 * Construction paths:
 *
 * - `createRenderSession(inputs)` — pure, explicit inputs (the kit's and tests' entry).
 * - `autoRenderSession(env, config, reportIssue?)` — the edge: resolves the selection and collects
 *   the converted themes, once per session.
 *
 * The seam owns NO ambient state: `view.highlight` reads only the
 * session's own resolution and the shared highlight cache (keyed on the
 * theme identity — see highlight.ts).
 */

import { dirname } from "node:path";

import { getReadmePath } from "@earendil-works/pi-coding-agent";

import type { PigmentConfig } from "#src/config/config-schema.ts";
import { createBoundedMap } from "#src/core/bounded-map.ts";
import { defaultIssueSink, type IssueSink } from "#src/core/issue.ts";
import type { SessionEnv } from "#src/core/session-env.ts";
import { hlBlockResolved, type CodeBlock, type FileCodeBlock } from "#src/theme/highlight.ts";
import { resolveCodeBlock } from "#src/theme/language.ts";
import {
  deriveResolvedTheme,
  polarityWarning,
  themeCacheKey,
  type ResolvedTheme,
  type DiffRootsSpec,
  type RenderTheme,
} from "#src/theme/scheme.ts";
import type { ShikiThemeInput } from "#src/theme/syntax-theme.ts";
import { resolveSyntaxThemeSelection } from "#src/theme/theme-resolver.ts";
import {
  resolveActiveThemeMemoized,
  type ActiveThemeMemo,
  type ThemeResolveInputs,
} from "#src/theme/theme-selection.ts";
import { collectConvertedThemes } from "#src/theme/user-themes.ts";

/**
 * A session's render inputs: everything the derived state depends on — the
 * theme-resolution family (`ThemeResolveInputs`) plus the diff roots the
 * scheme derivation consumes.
 */
export interface RenderSessionInputs extends ThemeResolveInputs {
  /** Diff-root overrides (the scheme's `diff` inputs, already resolved). */
  diffRoots: DiffRootsSpec | undefined;
}

/**
 * The render face: the pure rendering seam (scheme + highlight — everything
 * a renderer needs to paint code).
 * The chrome source (`theme`), the install root (`piRoot`), and the
 * token-theme observation point (`activeTheme`) stay on the internal
 * frame — `FrameView extends RenderView` pins narrow ⊆ full, so the
 * narrow face can only grow deliberately.
 */
export interface RenderView {
  /** The frame's color scheme (WCAG-enforced, root-derived). */
  readonly scheme: ResolvedTheme;
  /**
   * Highlight a code block through this session's resolution. Two spellings:
   * `{ code, language }` when the caller knows the language, `{ code,
   * filePath, context? }` when it knows the file — detection and seeding
   * happen inside (no I/O; the context text is caller-supplied).
   */
  highlight(block: CodeBlock | FileCodeBlock): Promise<string[]>;
}

/** One frame's derived view: the render face plus the internal chrome. */
export interface FrameView extends RenderView {
  /** The pi theme this view is bound to (the chrome colors' source). */
  readonly theme: RenderTheme;
  /**
   * The pi install root (the package dir owning README/docs/examples).
   * Resolved once per session — the root never moves within a session,
   * and per-frame filesystem walks would tax every classified header.
   */
  readonly piRoot: string;
  /**
   * The resolved token theme for this frame's polarity — the observation
   * point the golden-name / AA assertions (and non-tool renderers) read.
   * Null when the selection resolves to no theme (unstyled).
   */
  activeTheme(): Promise<ShikiThemeInput | null>;
}

/** A session's render seam: the immutable inputs plus the frame binder. */
export interface RenderSession {
  /** This frame's render view for the given pi theme. */
  forTheme(theme: RenderTheme): RenderView;
}

/** A session's internal seam: binds the full frame (chrome included). */
export interface FrameSession {
  /** This frame's derived view for the given pi theme. */
  forTheme(theme: RenderTheme): FrameView;
}

/**
 * Build the session's internal frame (chrome included) from explicit
 * inputs — pure, no I/O. Every memo inside keys on the identity of these
 * inputs, so a new session is exactly a new value (no invalidation
 * protocol exists or is needed).
 *
 * @param inputs - The session's render inputs.
 * @returns The internal session seam.
 * @internal - the extension's own assembly (ToolServices) and the test
 * fixtures; there is no public render surface.
 */
export function createFrameSession(inputs: RenderSessionInputs): FrameSession {
  // The per-session instance state: the active-theme memo, the scheme
  // memo, the install root, and the one-shot polarity-warning flag —
  // nothing here is reachable from another session instance.
  const themeMemo: ActiveThemeMemo = createBoundedMap(8);
  const schemeMemo = createBoundedMap<string, ResolvedTheme>(8);
  let warned = false;
  // The pi install root, resolved once (getReadmePath walks up with
  // sync existsSync per call — per-frame walks would tax every
  // classified header).
  let piRootMemo: string | undefined;

  /**
   * Derive this frame's scheme, reporting the polarity contradiction at
   * most once per session. Memoized per theme CONTENT (`themeCacheKey` is
   * content-verified), so repeated frames of one theme reuse the same
   * snapshot object.
   *
   * @param theme - The frame's pi theme.
   * @returns The resolved scheme.
   */
  const deriveFor = (theme: RenderTheme): ResolvedTheme => {
    const key = themeCacheKey(theme);
    const cached = schemeMemo.get(key);
    if (cached) return cached;
    const derived = deriveResolvedTheme(theme, inputs.diffRoots);
    if (!warned && derived.polarityOffenders.length > 0) {
      warned = true;
      console.error(polarityWarning(derived.polarityOffenders));
    }
    schemeMemo.set(key, derived.scheme);
    return derived.scheme;
  };

  return {
    forTheme(theme: RenderTheme): FrameView {
      const scheme = deriveFor(theme);
      const resolve = (): Promise<ShikiThemeInput | null> =>
        resolveActiveThemeMemoized(themeMemo, inputs, scheme, theme);
      const highlight = async (block: CodeBlock | FileCodeBlock): Promise<string[]> =>
        hlBlockResolved("filePath" in block ? resolveCodeBlock(block) : block, await resolve());
      return {
        scheme,
        theme,
        piRoot: (piRootMemo ??= dirname(getReadmePath())),
        activeTheme: resolve,
        highlight,
      };
    },
  };
}

/**
 * The edge: assemble the session seam from the environment, once. Resolves
 * the syntax-theme selection and collects the converted themes — the
 * config layers are the caller's (pre-loaded: the caller needs their
 * other fields anyway, and a second load would double the issues).
 *
 * @param env - The session environment (cwd + agentDir).
 * @param config - The loaded effective config (its syntaxTheme drives the
 *   selection).
 * @param reportIssue - The diagnostics sink (defaults to one stderr line).
 * @returns The session seam.
 */
export async function autoRenderSession(
  env: SessionEnv,
  config: PigmentConfig,
  reportIssue: IssueSink = defaultIssueSink,
): Promise<FrameSession> {
  const resolution = await resolveSyntaxThemeSelection(config.syntaxTheme, env);
  for (const issue of resolution.issues) reportIssue(issue.message);
  return createFrameSession({
    diffRoots: resolution.rootsSpec,
    selection: resolution.selection,
    themeEnv: env,
    convertedThemes: collectConvertedThemes(env),
  });
}

/**
 * Build a render session from explicit inputs — the pure factory
 * (no I/O). The same value as the internal frame, narrowed to the
 * render face by covariance: no adapter, no copy.
 *
 * @param inputs - The session's render inputs.
 * @returns The session seam (pure, no I/O).
 */
export function createRenderSession(inputs: RenderSessionInputs): RenderSession {
  return createFrameSession(inputs);
}
