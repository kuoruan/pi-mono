/**
 * Leak-probe — the retention probe for the render seam and the caches under it.
 *
 * Pnpm -C extensions/pi-pigment leak
 * node --expose-gc tools/leak-probe.ts [sessions=1200] [themeContents=40] [blocks=400]
 *
 * Every number is a heap delta after forced GC, so this is a TOOL, not a test:
 * heap sizes are environment-dependent and any threshold would flake. What it
 * answers, in order:
 *
 * A. does creating sessions leave anything reachable? Two batch sizes — growth
 * that scales with the batch is a leak; a constant total is warm-up noise.
 * B. what does a re-edited theme file cost, forever? Shiki's theme registry is
 * keyed by name and has no unload, so the content-distinct name file-channel
 * themes register under (themeIdentity) makes every distinct content
 * permanent — the one container our own bounds cannot reach.
 * C. is the highlight cache bound (192) visible in the heap? A second batch over
 * an already-full cache must come out flat.
 * D. what does the published render kit pin in `globalThis`?
 *
 * Validity guards exist because a silently degraded highlight path reports "no
 * growth" for EVERYTHING (harmless-looking output, meaningless numbers): the
 * warm-up must come out styled (a truecolor escape in the output) and must leave
 * the registry non-empty. The registry is read through the very module instance
 * `highlight.ts` uses — importing it under a different specifier would construct a
 * second HighlighterCore and then measure that empty one.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { themeNames } from "@shikijs/themes";

import { loadBundledTheme } from "#src/theme/bundled-intake.ts";
import { ensureCore } from "#src/theme/shiki-core.ts";
import type { MaterializedTheme } from "#src/theme/syntax-theme.ts";

import { createRenderSession } from "../render-kit.ts";

const SESSIONS = Number(process.argv[2] ?? 1200);
const THEME_CONTENTS = Number(process.argv[3] ?? 40);
const BLOCKS = Number(process.argv[4] ?? 400);

if (!global.gc) {
  console.error(
    "leak-probe needs --expose-gc (use `pnpm leak`, or node --expose-gc tools/leak-probe.ts)",
  );
  process.exit(1);
}

const gc = (): void => {
  for (let i = 0; i < 5; i++) global.gc?.();
};
const heap = (): number => {
  gc();
  return process.memoryUsage().heapUsed;
};
const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(2)}MB`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`;

const core = await ensureCore("typescript");
if (!core) throw new Error("ensureCore returned no core");
const registry = (): number => core.getLoadedThemes().length;

/** A fixture-shaped pi theme (tests/fixtures' buildRenderTheme, inlined). */
const piTheme = {
  name: "probe",
  fg: (_name: ThemeColor, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (name: ThemeColor) =>
    name === "toolDiffAdded"
      ? "\x1b[38;2;100;180;120m"
      : name === "toolDiffRemoved"
        ? "\x1b[38;2;200;100;100m"
        : "\x1b[38;2;128;128;128m",
  getBgAnsi: () => "\x1b[48;2;30;30;40m",
  bg: (_name: "toolSuccessBg" | "toolErrorBg", text: string) =>
    `\x1b[48;2;30;30;40m${text}\x1b[49m`,
};

const env = { cwd: process.cwd(), agentDir: "/tmp/pigment-leak-probe-agent" };
const CODE = [
  "export interface Row { id: string; text: string; depth: number }",
  "",
  "export function fold(rows: Row[]): Map<string, Row[]> {",
  "  const out = new Map<string, Row[]>();",
  "  for (const row of rows) {",
  "    const bucket = out.get(row.id) ?? [];",
  "    bucket.push({ ...row, depth: row.depth + 1 });",
  "    out.set(row.id, bucket);",
  "  }",
  "  return out;",
  "}",
  "",
  "const cache = new WeakMap<object, string>();",
  "export function key(o: object): string {",
  "  const hit = cache.get(o);",
  "  if (hit !== undefined) return hit;",
  "  const k = JSON.stringify(o);",
  "  cache.set(o, k);",
  "  return k;",
  "}",
  "",
].join("\n");

// The polarity warning is a per-session stderr write; async stream buffering would
// pollute the heap numbers, so count it instead of printing it.
const realError = console.error;
let warnings = 0;
console.error = () => {
  warnings++;
};

/**
 * One session's frame: build the seam, derive the view, highlight one block.
 *
 * @param selection - The session's theme selection.
 * @param code - The block to highlight.
 * @returns The highlighted lines.
 */
async function sessionWith(
  selection: Parameters<typeof createRenderSession>[0]["selection"],
  code = CODE,
): Promise<string[]> {
  const session = createRenderSession({
    diffRoots: undefined,
    selection,
    themeEnv: env,
    convertedThemes: [],
  });
  return session.forTheme(piTheme).highlight({ code, language: "typescript" });
}

/**
 * Guard: an unstyled result means the highlight path never ran (numbers would lie).
 *
 * @param lines - The rendered lines.
 * @param what - The stage's label for the error message.
 */
function assertStyled(lines: string[], what: string): void {
  if (!lines.some((line) => line.includes("\x1b[38;2;"))) {
    throw new Error(`${what}: output is UNSTYLED — the highlight path did not run`);
  }
}

assertStyled(await sessionWith({ kind: "auto" }), "warm-up");
if (registry() === 0) {
  throw new Error("registry still 0 after a styled highlight — wrong core instance");
}
console.error = realError;
console.log(`warm-up: registry=${registry()} heap=${mb(heap())} polarityWarnings=${warnings}\n`);

// --- A. per-session churn ---------------------------------------------------
for (const count of [Math.min(SESSIONS, 300), SESSIONS]) {
  const base = heap();
  const baseRegistry = registry();
  for (let i = 0; i < count; i++) await sessionWith({ kind: "auto" });
  const after = heap();
  console.log(
    `A. ${count} sessions, one highlight each (same block — cache hits after the first)\n` +
      `   heap ${mb(base)} → ${mb(after)}  (delta ${kb(after - base)}, ${((after - base) / count).toFixed(0)}B/session)\n` +
      `   registry ${baseRegistry} → ${registry()}  (delta ${registry() - baseRegistry})\n`,
  );
}

// --- B. theme-content churn (a re-edited theme file) ------------------------
let bundled: MaterializedTheme | undefined;
for (const name of ["one-dark-pro", "github-dark", "dracula", ...themeNames]) {
  bundled = await loadBundledTheme(name);
  if (bundled) break;
}
if (!bundled) throw new Error("no bundled theme loadable");
const bBase = heap();
const bBaseRegistry = registry();
for (let i = 0; i < THEME_CONTENTS; i++) {
  const theme: MaterializedTheme = {
    ...bundled,
    name: "user-theme",
    contentFingerprint: `fp${i}`,
    colors: { ...bundled.colors, "editor.background": `#10${String(i).padStart(2, "0")}10` },
  };
  await sessionWith({ kind: "file", file: { name: "user-theme", theme } });
}
const bAfter = heap();
const grown = registry() - bBaseRegistry;
console.log(
  `B. ${THEME_CONTENTS} DISTINCT theme contents under one name (a re-edited file)\n` +
    `   heap ${mb(bBase)} → ${mb(bAfter)}  (delta ${kb(bAfter - bBase)})\n` +
    `   registry ${bBaseRegistry} → ${registry()}  (delta ${grown})\n` +
    `   → ${
      grown
        ? `${kb((bAfter - bBase) / grown)} retained per distinct content, for the process lifetime`
        : "no growth"
    }\n`,
);

// --- C. the highlight cache bound -------------------------------------------
const cBase = heap();
for (let i = 0; i < BLOCKS; i++) {
  await sessionWith({ kind: "auto" }, `${CODE}\n// block ${i}\n`);
}
const cAfter = heap();
for (let i = 0; i < BLOCKS; i++) {
  await sessionWith({ kind: "auto" }, `${CODE}\n// second batch ${i}\n`);
}
const cSecond = heap();
console.log(
  `C. ${BLOCKS} DISTINCT blocks, then ${BLOCKS} more (the cache bound is 192)\n` +
    `   first batch:  heap ${mb(cBase)} → ${mb(cAfter)}  (delta ${kb(cAfter - cBase)})\n` +
    `   second batch: heap ${mb(cAfter)} → ${mb(cSecond)}  (delta ${kb(cSecond - cAfter)} — flat means the bound holds)\n`,
);

// --- D. what the publication pins -------------------------------------------
const { createRenderKit, publishRenderKit, RENDER_KIT_KEY } = await import("../render-kit.ts");
const kit = await createRenderKit(env);
publishRenderKit();
const held = (globalThis as Record<symbol, unknown>)[Symbol.for(RENDER_KIT_KEY)] as
  | Record<string, unknown>
  | undefined;
console.log(
  `D. globalThis[Symbol.for("${RENDER_KIT_KEY}")]: ${held ? `present, keys [${Object.keys(held).join(", ")}]` : "absent"}\n` +
    `   kit.tools=${kit.tools.length}; the payload holds functions and names only — no session\n`,
);
