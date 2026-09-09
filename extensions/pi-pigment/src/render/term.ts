/**
 * The terminal-environment seam: the ONLY module reading the process
 * environment for rendering decisions (width sensing). Cannot be cached —
 * terminal resizes must be seen by the next render.
 */

/** Max terminal width used when measuring. */
const MAX_TERM_WIDTH = 210;
/** Default terminal width when nothing can be detected. */
const DEFAULT_TERM_WIDTH = 200;

/**
 * The terminal's current width in columns, clamped to the render range:
 * COLUMNS env override, else the stream widths, else the default.
 *
 * @returns The terminal width in columns.
 */
export function termW(): number {
  const raw =
    Number.parseInt(process.env.COLUMNS ?? "", 10) ||
    (process.stdout.columns ?? 0) ||
    (process.stderr.columns ?? 0) ||
    DEFAULT_TERM_WIDTH;
  return Math.max(80, Math.min(raw - 4, MAX_TERM_WIDTH));
}
