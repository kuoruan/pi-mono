/**
 * File-path → Shiki language detection: the SDK's own extension map first
 * (the authority — it knows the C-header and makefile spellings), then
 * Shiki's language keys (ids + alias registry, which the community keeps
 * populated with newer extensions), then the header spellings neither
 * carries. Split out of highlight.ts (the seed-module extraction) so the
 * highlight entry owns only caching + rendering.
 */

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { bundledLanguages, bundledLanguagesAlias } from "shiki";

import type { BundledLanguage } from "./shiki-core.ts";

/**
 * The language keys Shiki's bundle accepts: language ids plus registered
 * aliases — which the community keeps populated with file extensions
 * ("ts", "py", "zig", "nu", …). This set IS the extension map: a file's
 * extension (lowercased) that hits the set is a valid `lang` argument as-is,
 * covering 300+ languages without a hand-maintained table. Extensionless
 * convention files match too ("Makefile" → "makefile").
 */
const LANGUAGE_KEYS: ReadonlySet<string> = new Set(
  [...Object.keys(bundledLanguages), ...Object.keys(bundledLanguagesAlias)].map((key) =>
    key.toLowerCase(),
  ),
);

/** The few header extensions neither the SDK's map nor Shiki's keys carry. */
const EXTRA_EXT_LANG: Record<string, BundledLanguage> = {
  hxx: "cpp",
  hh: "cpp",
};

/**
 * Detect the Shiki language for a file path.
 *
 * @param filePath - The file path to inspect.
 * @returns The Shiki language id, or undefined when unknown.
 */
export function detectLanguage(filePath: string): BundledLanguage | undefined {
  const sdk = getLanguageFromPath(filePath);
  if (sdk) return sdk as BundledLanguage;
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = (dot === -1 ? name : name.slice(dot + 1)).toLowerCase();
  if (!ext) return undefined;
  if (LANGUAGE_KEYS.has(ext)) return ext as BundledLanguage;
  return EXTRA_EXT_LANG[ext];
}
