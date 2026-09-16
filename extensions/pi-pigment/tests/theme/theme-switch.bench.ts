import type { HighlighterCore } from "shiki/core";
/**
 * The theme-switch re-highlight cost: N code blocks rendered under theme A (the
 * pre-switch state, cache primed), then the same blocks under theme B — every
 * highlight-cache key carries the theme's content identity, so a switch is N cold
 * re-tokenizes + re-styles, the hitch a /settings theme switch pays.
 *
 * Ported from the former tools/theme-switch-bench.js, which drifted out of the
 * source API twice (hlBlock's call shape, then the render seam that deleted it);
 * here `pnpm check` type-checks it and `pnpm vitest bench` runs it with the rest.
 *
 * Run it alone:
 * pnpm vitest bench tests/theme/theme-switch.bench.ts
 *
 * Every cold leg clears the shared highlight cache first: that IS the switched
 * state (no entry carries theme B's identity), and it keeps every iteration
 * measuring the same work — with a fixed identity every iteration after the first
 * would be a cache hit and measure nothing. The cold legs also build a session per
 * iteration, because a switch is a session (the render state is per-session by
 * construction), so their numbers include the palette derivation the switch pays.
 *
 * The tokenize-only split names the tokenizer's share; the remainder is our ANSI
 * rendering, not shiki. It runs on a representative bundled theme because
 * tokenization is theme-independent (the theme only maps scopes to colors).
 *
 * Smaller than the CLI tool's defaults (30 blocks x 60 lines): a bench repeats its
 * callback, so 8 x 40 keeps the file's runtime in the same range as its siblings
 * while still paying one cold re-tokenize per block per iteration.
 *
 * READ THE RATIOS, NOT THE ABSOLUTES: tinybench's per-iteration accounting for an
 * async callback adds a fixed ~0.45ms in this environment — the same 8 cached
 * blocks measure 0.48ms per iteration here and 39µs standalone (4.7µs/block, one
 * tinybench turn per `await` into the worker's event loop). The cold/warm ratio is
 * therefore what a change moves; the absolute means are not per-frame costs. The
 * file's sibling benches are unaffected: their callbacks are synchronous, and the
 * shiki legs pay milliseconds where 0.45ms is noise.
 */
import { beforeAll, test } from "vitest";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { clearHighlightCacheForTest } from "#src/theme/highlight.ts";
import type { PaletteTheme } from "#src/theme/palette.ts";
import { ensureCore } from "#src/theme/shiki-core.ts";
import { buildFakeTheme, viewFor } from "#test/fixtures.ts";

// One module-level sink absorbs every measured return value (DCE guard).
let sink = 0;

const BLOCKS = 8;
const LINES = 40;
const LANGUAGE = "typescript";
const INTAKE_THEME = "nord";

/**
 * One deterministic realistic TypeScript block.
 *
 * @param i - The block index (drives the deterministic content).
 * @returns The block's code.
 */
function block(i: number): string {
  let code = `// block ${i}: generated benchmark slice\nimport { readFileSync } from "node:fs";\n`;
  for (let l = 3; l < LINES; l++) {
    const shape = l % 7;
    if (shape === 0) code += `const value${l} = "${"x".repeat(l % 23)}";\n`;
    else if (shape === 1) code += `// line ${l}: ${l % 11 === 0 ? "TODO(review)" : "note"}\n`;
    else if (shape === 2) code += `function handler${l}(input: string): number {\n`;
    else if (shape === 3) code += `  return input.length + ${l};\n}\n`;
    else if (shape === 4) code += `export type Shape${l} = { key: string; n: ${l % 97} };\n`;
    else if (shape === 5) code += `const re${l} = /^[a-z]{${l % 9},${(l % 9) + 4}}$/i;\n`;
    else code += `if (value${l}?.size > ${l}) {\n  console.log("branch ${l}");\n}\n`;
  }
  return code;
}

const blocks = Array.from({ length: BLOCKS }, (_, i) => ({ code: block(i) }));

/**
 * A fixture theme whose CONTENT differs per tint (not just its name): the derived
 * syntax theme's identity is its adjusted colors + the theme key, so a pair with
 * identical content would share one cache identity and the "switch" would measure
 * nothing.
 *
 * @param name - The theme name.
 * @param tint - The keyword color's red channel.
 * @returns The palette-theme surface.
 */
function tinted(name: string, tint: number): PaletteTheme {
  const base = buildFakeTheme({ name, syntaxColors: true });
  return {
    ...base,
    getFgAnsi: (color) =>
      color === "syntaxKeyword" ? `\x1b[38;2;${tint};156;214m` : base.getFgAnsi(color),
  };
}

const themeA = tinted("bench-a", 86);
const themeB = tinted("bench-b", 200);
const env = { cwd: process.cwd(), agentDir: "/tmp/pigment-theme-switch-bench" };

// The warm leg reuses ONE session: a switch is a session, a steady-state frame is
// not, so building one per iteration would fold the palette derivation (which a
// switch pays and a frame does not) into the cache-hit baseline.
const warmView = viewFor(themeA, { themeEnv: env });
let core: HighlighterCore | undefined;
let tokenizeTheme: string | undefined;
/** The name the tokenize leg registers under: ours, so the id it passes is certain. */
const TOKENIZE_THEME = "pi-bench-tokenize";

beforeAll(async () => {
  for (const b of blocks)
    sink += (await warmView.highlight({ code: b.code, language: LANGUAGE })).length;
  core = await ensureCore(LANGUAGE);
  const materialized = await loadBundledTheme(INTAKE_THEME);
  if (core && materialized) {
    // Register under a name WE choose: the leg then names its own theme id instead
    // of trusting whatever name the intake materialized.
    await core.loadTheme({ ...materialized, name: TOKENIZE_THEME });
    tokenizeTheme = TOKENIZE_THEME;
  }
});

test("theme switch (blocks x lines)", async ({ bench }) => {
  await bench(`warm: ${BLOCKS} blocks under theme A (same session, cache hits)`, async () => {
    for (const b of blocks)
      sink += (await warmView.highlight({ code: b.code, language: LANGUAGE })).length;
  }).run();

  await bench(`cold switch, sequential: ${BLOCKS} blocks under theme B`, async () => {
    clearHighlightCacheForTest();
    const view = viewFor(themeB, { themeEnv: env });
    for (const b of blocks)
      sink += (await view.highlight({ code: b.code, language: LANGUAGE })).length;
  }).run();

  await bench(`cold switch, parallel: ${BLOCKS} blocks under theme B`, async () => {
    clearHighlightCacheForTest();
    const view = viewFor(themeB, { themeEnv: env });
    const rendered = await Promise.all(
      blocks.map((b) => view.highlight({ code: b.code, language: LANGUAGE })),
    );
    for (const lines of rendered) sink += lines.length;
  }).run();
});

test("theme switch (the tokenizer's share)", async ({ bench }) => {
  await bench(`tokenize only: ${BLOCKS} blocks (codeToTokensBase)`, async () => {
    if (!core || !tokenizeTheme) throw new Error("tokenize-only leg needs the bundled theme");
    for (const b of blocks) {
      const tokens = await core.codeToTokensBase(b.code, { lang: LANGUAGE, theme: tokenizeTheme });
      sink += tokens.length;
    }
  }).run();

  await bench(`bundled theme intake, memo hit (${INTAKE_THEME})`, async () => {
    sink += (await loadBundledTheme(INTAKE_THEME))?.tokenColors?.length ?? 0;
  }).run();
});
