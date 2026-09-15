/**
 * The diagnostics record every pigment layer shares (config loading, theme
 * files, theme conversion): one problem, reported through an `IssueSink`,
 * never fatal.
 */

/** One diagnostic problem. */
export interface Issue {
  /** The human-readable problem. */
  message: string;
  /** The file it came from (when applicable). */
  sourcePath?: string;
}

/** A diagnostics sink: one human-readable line per issue. */
export type IssueSink = (message: string) => void;

// The default diagnostics sink — one stderr line per issue.
export const defaultIssueSink: IssueSink = (message) => console.error(`[pi-pigment] ${message}`);
