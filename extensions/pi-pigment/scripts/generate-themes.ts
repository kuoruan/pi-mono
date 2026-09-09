/**
 * The pre-generation script (ADR 0006): converts every bundled shiki theme
 * into a pi theme JSON under themes/, committed as package assets. pi
 * discovers them through the package manifest's `pi.themes` entry — zero
 * runtime generation for the bundled set.
 *
 * Diff roots extract from each theme's own tokens (greens/reds) — the
 * same derivation the palette performed at render time, moved wholesale
 * to generation time. Families carry no separate diff colors (they never
 * did — pairing data only).
 *
 * Run: pnpm -C extensions/pi-pigment exec tsx scripts/generate-themes.ts
 * CI freshness: rerun + `git diff --exit-code themes/`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { themeNames } from "@shikijs/themes";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { convertToPiTheme } from "#src/theme/pi-theme-converter.ts";

/** The output directory (package root / themes — pi's manifest points here). */
const THEMES_DIR = join(import.meta.dirname, "..", "themes");

async function main(): Promise<void> {
  // Clean slate: the directory is ours (generated assets, no hand edits —
  // customization copies OUT, per the documented policy).
  await rm(THEMES_DIR, { recursive: true, force: true });
  await mkdir(THEMES_DIR, { recursive: true });

  const issues: string[] = [];
  let written = 0;
  const names = [...themeNames].toSorted();
  for (const name of names) {
    const theme = await loadBundledTheme(name);
    if (!theme) {
      issues.push(`failed to load bundled theme "${name}"`);
      continue;
    }
    const { doc, issues: convertIssues } = convertToPiTheme(theme, `pigment-${name}`);
    for (const issue of convertIssues) issues.push(issue.message);
    if (!doc) continue;
    await writeFile(join(THEMES_DIR, `${doc.name}.json`), `${JSON.stringify(doc, null, "  ")}\n`);
    written++;
  }
  console.log(`[generate-themes] wrote ${written} themes to ${THEMES_DIR}`);
  for (const issue of issues) console.error(`[generate-themes] ${issue}`);
  if (issues.length > 0) process.exitCode = 1;
}

void main();
