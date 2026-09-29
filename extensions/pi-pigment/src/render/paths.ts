/**
 * Display-path shortening: cwd-relative when inside, `~`-prefixed under the
 * user's home, absolute otherwise.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Collapse a path under the user's home to `~`-prefixed form (the SDK
 * render-utils shortenPath, copied — the package map forbids the deep
 * import). Deliberately NOT byte-identical: the SDK matches a bare
 * prefix (`/home/alice` shortens `/home/alicey`); this keeps the
 * segment boundary (matching our own shortPath).
 *
 * @param p - The path to shorten.
 * @returns The `~`-prefixed path, or p unchanged.
 */
export function shortHome(p: string): string {
  const home = process.env.HOME ?? homedir();
  if (home && (p === home || (p.startsWith(home + sep) && p.length > home.length + 1))) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

/**
 * The inverse of shortHome for link targets: node resolve() does not
 * expand `~`, but the SDK's resolvePath does (and the tool itself
 * resolves it at execution) — a literal `~/x` arg must link to the
 * home-joined location, never <cwd>/~/x.
 *
 * @param p - The raw path arg.
 * @returns The path with a leading `~` expanded.
 */
export function expandHome(p: string): string {
  if (p !== "~" && !p.startsWith(`~${sep}`)) return p;
  const home = process.env.HOME ?? homedir();
  return p === "~" ? home : join(home, p.slice(2));
}

/**
 * Render a file path for display: cwd-relative, paths under the user's home
 * become `~`-prefixed, and everything else stays absolute. (Cross-platform
 * via os.homedir(); a missing HOME env var cannot corrupt the output.)
 *
 * @param cwd - The session working directory.
 * @param p - The path to shorten.
 * @returns The display path.
 */
export function shortPath(cwd: string, p: string): string {
  if (!p) return p;
  const r = relative(cwd, p);
  // "Outside" is `..` as a PATH SEGMENT (../x or ..) — a file named
  // `..foo` inside cwd yields the relative "..foo", which is inside.
  const outside = r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r);
  if (!outside) return r;
  return shortHome(p);
}

/**
 * Resolve a tool path arg the SDK's way (`resolveToCwd`: absolute
 * stays, `@` strips, `~` expands to the home-joined location,
 * otherwise relative to the session cwd — never `process.cwd()`, a
 * resumed/switched session may sit in a different directory than the
 * process started in). One seam for every decorative filesystem touch
 * in the render layer. `file://` and unicode-space normalization are
 * the SDK's, not ours — an exotic arg degrades the preview, never the
 * frame.
 *
 * @param cwd - The session working directory.
 * @param p - The raw path arg.
 * @returns The absolute path, or "" when the arg is empty.
 */
export function resolveToolPath(cwd: string, p: string): string {
  if (!p) return "";
  const unprefixed = p.startsWith("@") ? p.slice(1) : p;
  if (isAbsolute(unprefixed)) return resolve(unprefixed);
  return resolve(cwd, expandHome(unprefixed));
}

/**
 * Read a file for RENDERING ONLY (diff pre-reads, grammar seeds,
 * existence probes): never throws — an unreadable file degrades the
 * preview (unseeded, treated as new), never the frame.
 *
 * @param absolute - The resolved absolute path ("" reads as undefined).
 * @returns The file text, or undefined when unreadable.
 */
export function readDecorativeText(absolute: string): string | undefined {
  if (!absolute) return undefined;
  try {
    return readFileSync(absolute, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Probe a file's existence for RENDERING ONLY: never throws.
 *
 * @param absolute - The resolved absolute path ("" probes as false).
 * @returns True when the file exists and is readable.
 */
export function decorativeExists(absolute: string): boolean {
  if (!absolute) return false;
  try {
    return existsSync(absolute);
  } catch {
    return false;
  }
}

/**
 * Normalize a path to POSIX separators: the language detector and the
 * highlight entry split on "/", and a Windows-style `\\` would hide the
 * extension from them. Display paths keep the native separator — this is
 * detection-only, never shown.
 *
 * @param filePath - The path to normalize.
 * @returns The path with platform separators replaced by "/".
 */
export function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}
