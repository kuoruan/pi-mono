/**
 * Display-path shortening: cwd-relative when inside, `~`-prefixed under the
 * user's home, absolute otherwise.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

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
