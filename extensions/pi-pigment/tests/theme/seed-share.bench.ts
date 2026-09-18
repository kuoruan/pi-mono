/**
 * The seeded-diff re-highlight cost: N hunk blocks sharing ONE grammar seed
 * (the vue-diff shape — every hunk carries the file text before it as
 * `grammarContextCode`, so the seed is tokenized N times). Clearing the
 * highlight cache per iteration measures the full cold cost a multi-hunk
 * diff pays on its settle frame.
 *
 * Run it alone:
 * pnpm vitest bench tests/theme/seed-share.bench.ts
 *
 * READ THE RATIOS, NOT THE ABSOLUTES: see theme-switch.bench.ts's note on
 * tinybench's ~0.45ms per-iteration accounting for async callbacks.
 */
import { test } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { textBeforeLine } from "#src/core/lines.ts";
import { setDiffPreviewTask, type PreviewTextHost } from "#src/render/text-task.ts";
import { clearHighlightCacheForTest } from "#src/theme/highlight.ts";
import { buildFakeTheme, makeRenderCtx, makeTextComponent, viewFor } from "#test/fixtures.ts";
// One module-level sink absorbs every measured return value (DCE guard).
let sink = 0;

const BLOCKS = 8;
const SEED_LINES = 200;
const HUNK_LINES = 15;

/**
 * A deterministic vue seed: template + a tsx script head, so the grammar
 * state at the seed's end sits inside the script embedding.
 *
 * @returns The seed text.
 */
function seed(): string {
  let code = `<template>\n  <div class="page">\n`;
  for (let l = 0; l < 40; l++) code += `    <span :key="${l}">row ${l}</span>\n`;
  code += `  </div>\n</template>\n\n<script lang="tsx" setup>\n`;
  code += `import { ref } from "vue";\n`;
  for (let l = 0; l < SEED_LINES; l++) {
    code += `const field${l} = ref<string>("value-${l}");\n`;
  }
  return code;
}

/**
 * One deterministic hunk block: tsx-flavored script lines.
 *
 * @param i - The block index (drives the deterministic content).
 * @returns The hunk code.
 */
function hunk(i: number): string {
  let code = "";
  for (let l = 0; l < HUNK_LINES; l++) {
    code += `const currentFilterValues${i}_${l} = ref<ViewFieldFilter[]>([]);\n`;
  }
  return code;
}

const SEED = seed();
const hunks = Array.from({ length: BLOCKS }, (_, i) => hunk(i));
const view = viewFor(buildFakeTheme({ syntaxColors: true }));

/**
 * One filler script row range.
 *
 * @param from - The first row index.
 * @param to - The past-the-end row index.
 * @returns The generated assignment rows.
 */
function padRows(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `const pad${from + i} = ${from + i};`);
}

/**
 * A three-hunk vue diff whose separators straddle the unified window: the
 * narrow render slices the seed at the second hunk, the wide render at the
 * third — before the view-independent slice fix, a resize re-keyed every
 * hunk block and paid a full cold re-highlight.
 *
 * @returns The parsed diff and the new-file text (the seed source).
 */
function wideDiff(): { diff: ReturnType<typeof parseDiff>; fileText: string } {
  const oldLines = ['<script setup lang="ts">', ...padRows(0, 400), "</script>"];
  const newLines = [...oldLines];
  for (const at of [10, 150, 290]) {
    for (let i = 0; i < 80; i++) newLines[at + i] = `const pad${at + i} = 999;`;
  }
  const fileText = `${newLines.join("\n")}\n`;
  return { diff: parseDiff(`${oldLines.join("\n")}\n`, fileText), fileText };
}

const { diff: WIDE_DIFF, fileText: WIDE_FILE } = wideDiff();

test("seeded diff (shared seed x N hunks)", async ({ bench }) => {
  await bench(`cold: ${BLOCKS} vue hunks sharing one seed`, async () => {
    clearHighlightCacheForTest();
    for (const code of hunks) {
      sink += (await view.highlight({ code, language: "vue", seed: SEED })).length;
    }
  }).run();

  await bench("resize: same 3-hunk diff narrow then wide (seed stability)", async () => {
    clearHighlightCacheForTest();
    const host = makeTextComponent();
    const mc = makeRenderCtx();
    setDiffPreviewTask({
      text: host as unknown as PreviewTextHost,
      keyPrefix: "wd",
      diff: WIDE_DIFF,
      language: "typescript",
      maxLines: 150,
      view: viewFor(buildFakeTheme({ syntaxColors: true })),
      ctx: mc.ctx,
      indicatorStyle: "bar",
      seedFor: (start) => textBeforeLine(WIDE_FILE, start),
    });
    sink += (await host.previewTask!.render(60)).length;
    sink += (await host.previewTask!.render(120)).length;
  }).run();
});
