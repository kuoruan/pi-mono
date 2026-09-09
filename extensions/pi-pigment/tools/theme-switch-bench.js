// theme-switch-bench.js — benchmark the theme-switch re-highlight cost:
// N visible code blocks, theme A warm (the pre-switch state), then theme B
// (cold highlight cache) — the two passes a /settings theme switch costs.
//
//   node tools/theme-switch-bench.js [N=30] [lines=60]
//
// (No --experimental-strip-types needed: the .ts imports below rely on
// Node's default type stripping, on by default since Node 22.18.)
//
// Reports parallel and sequential re-style totals + ms-per-block. The
// parallel number is the render-flood shape; the sequential one is the
// async-upgrade shape.

import { performance } from "node:perf_hooks";

import { hlBlock } from "../src/theme/highlight.ts";
import { resolveDiffPalette } from "../src/theme/palette.ts";
import { setSyntaxThemeSelection } from "../src/theme/theme-selection.ts";

const N = Number(process.argv[2] ?? 30);
const LINES = Number(process.argv[3] ?? 60);

/**
 * A fixture-shaped pi theme (the fixtures' buildFakeTheme, inlined).
 *
 * @param name - The theme name.
 * @param tint - The keyword color's green channel (distinct identities).
 * @returns The palette-theme surface.
 */
function fakeTheme(name, tint) {
  const fg = {
    toolTitle: "\x1b[38;2;138;180;255m",
    accent: "\x1b[38;2;138;180;255m",
    muted: "\x1b[38;2;130;130;140m",
    dim: "\x1b[38;2;110;110;120m",
    success: "\x1b[38;2;100;200;120m",
    error: "\x1b[38;2;255;100;100m",
    toolDiffAdded: "\x1b[38;2;80;220;120m",
    toolDiffRemoved: "\x1b[38;2;240;90;90m",
    toolDiffContext: "\x1b[38;2;130;130;130m",
    syntaxComment: "\x1b[38;2;106;153;85m",
    syntaxKeyword: `\x1b[38;2;${tint};156;214m`,
    syntaxFunction: "\x1b[38;2;220;220;170m",
    syntaxVariable: "\x1b[38;2;156;220;254m",
    syntaxString: "\x1b[38;2;206;145;120m",
    syntaxNumber: "\x1b[38;2;181;206;168m",
    syntaxType: "\x1b[38;2;78;201;176m",
    syntaxOperator: "\x1b[38;2;212;212;212m",
    syntaxPunctuation: "\x1b[38;2;212;212;212m",
  };
  const bg = { toolSuccessBg: "\x1b[48;2;30;30;40m", toolErrorBg: "\x1b[48;2;40;30;30m" };
  return {
    name,
    fg: (n, t) => `${fg[n] ?? ""}${t}\x1b[0m`,
    bg: (n, t) => `${bg[n] ?? ""}${t}\x1b[0m`,
    getFgAnsi: (n) => fg[n] ?? "",
    getBgAnsi: (n) => bg[n] ?? "",
    bold: (t) => `\x1b[1m${t}\x1b[22m`,
  };
}

/**
 * One deterministic realistic TypeScript block.
 *
 * @param i - The block index (drives the deterministic content).
 * @returns The block's code.
 */
function block(i) {
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

const blocks = Array.from({ length: N }, (_, i) => ({ code: block(i) }));
setSyntaxThemeSelection({ kind: "auto" });

const fakeA = fakeTheme("bench-a", 86);
const fakeB = fakeTheme("bench-b", 200);
const paletteA = resolveDiffPalette(fakeA);
const paletteB = resolveDiffPalette(fakeB);

// Warm pass: the pre-switch state (theme A cached).
for (const b of blocks) {
  await hlBlock(b.code, "ts", paletteA, fakeA);
}

// Theme switch: every block's cache entry is now cold (identity changed).
let t0 = performance.now();
await Promise.all(blocks.map((b) => hlBlock(b.code, "ts", paletteB, fakeB)));
const parallelMs = performance.now() - t0;

// The sequential cold shape (theme C — fresh identity, no parallel flood).
const fakeC = fakeTheme("bench-c", 40);
const paletteC = resolveDiffPalette(fakeC);
t0 = performance.now();
for (const b of blocks) {
  await hlBlock(b.code, "ts", paletteC, fakeC);
}
const sequentialMs = performance.now() - t0;

// The tokenize-only split (one theme object, no per-block loadTheme).
const { ensureCore } = await import("../src/theme/shiki-core.ts");
const core = await ensureCore("ts");
const active = await import("../src/theme/theme-selection.ts").then((m) =>
  m.resolveActiveTheme(paletteC, fakeC),
);
const themeObject =
  typeof active === "string" || !active
    ? { name: "none" }
    : { ...active, name: active.name || "n" };
await core.loadTheme(themeObject);
t0 = performance.now();
for (const b of blocks) {
  await core.codeToTokensBase(b.code, { lang: "ts", theme: themeObject.name });
}
const tokenizeMs = performance.now() - t0;
const renderMs = sequentialMs - tokenizeMs;

const ms = (v) => v.toFixed(1);
console.log(
  `blocks=${N} lines=${LINES} | cold parallel=${ms(parallelMs)}ms (${ms(parallelMs / N)}/block) | cold sequential=${ms(sequentialMs)}ms (${ms(sequentialMs / N)}/block) | tokenize-only=${ms(tokenizeMs)}ms | non-tokenize=${ms(renderMs)}ms`,
);
