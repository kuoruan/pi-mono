/**
 * Display-path shortening: cwd-relative when inside, `~`-prefixed under the
 * user's home, absolute otherwise.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

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
  const home = homedir();
  // Match at a path-segment boundary: /home/alice must not match
  // /home/alicey (both separators, so Windows backslash paths work too).
  if (home && (p === home || (p.startsWith(home + sep) && p.length > home.length + 1))) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}
