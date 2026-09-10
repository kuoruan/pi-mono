import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SEED_CHARS } from "#src/theme/highlight.ts";
import {
  buildFakeTheme,
  makeRenderCtx,
  plain,
  registerTools,
  resetPigmentForTest,
  toolOf,
  type TextDouble,
} from "#test/fixtures.ts";
import { vol } from "#test/memfs.ts";

vi.mock("node:fs");
vi.mock("fs");
vi.mock("node:fs/promises");
vi.mock("fs/promises");

/**
 * The row state's read, plain-joined (the seed memo's observable).
 *
 * @param state - The render row state.
 * @returns The read lines joined, or an empty string when unread.
 */
const linesOfState = (state: object): string =>
  ((state as { seedLines?: string[] }).seedLines ?? []).join("\n");

const CWD = "/render-project";

/**
 * One filler script row (the oversized-prefix test's padding).
 *
 * @param i - The row index.
 * @returns The generated assignment row.
 */
const padRow = (i: number): string => `const pad${i} = ref(${i});`;

/**
 * A small SFC whose script block sits below the first line (the seed's
 * shape: a mid-file hunk with the embedding tag out of view).
 *
 * @param scriptRows - The script block's rows.
 * @returns The file text.
 */
const vue = (...scriptRows: string[]): string =>
  [
    "<template>",
    "  <p>item</p>",
    "</template>",
    "",
    '<script setup lang="ts">',
    "import { ref } from 'vue';",
    ...scriptRows,
    "</script>",
  ].join("\n");

/** A LONG vue file: the tested change sits mid-file with no tag in view. */
const LONG_VUE = [
  "<template>",
  ...Array.from({ length: 40 }, (_, i) => `  <p>item ${i}</p>`),
  "</template>",
  "",
  '<script setup lang="ts">',
  "import { ref } from 'vue';",
  ...Array.from({ length: 80 }, (_, i) => `const value${i} = ref(${i});`),
  "</script>",
].join("\n");

beforeEach(() => {
  resetPigmentForTest();
  vol.reset();
  vol.mkdirSync(CWD, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = "/render-agent";
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  vol.reset();
});

describe("vue edit result coloring (full seam)", () => {
  it(
    "colors the script hunk below a template hunk (the seed spans ALL visible hunks)",
    { timeout: 30000 },
    async () => {
      vol.writeFileSync(
        `${CWD}/app.vue`,
        [
          "<template>",
          "  <div>X {{ msg }}</div>",
          "</template>",
          "",
          '<script setup lang="ts">',
          "import { ref } from 'vue';",
          "const count = ref(0);",
          "</script>",
        ].join("\n"),
      );
      const tools = await registerTools({ cwd: CWD });
      const edit = toolOf(tools, "edit");
      const result = await edit.execute!(
        "t-vue",
        {
          path: `${CWD}/app.vue`,
          edits: [
            { oldText: "<div>X {{ msg }}</div>", newText: "<div>Y {{ msg }}</div>" },
            { oldText: "ref(0)", newText: "ref(7)" },
          ],
        },
        undefined,
        undefined,
        undefined,
      );
      const mc = makeRenderCtx();
      const rctx = mc.ctx;
      rctx.args = {
        path: `${CWD}/app.vue`,
        edits: [
          { oldText: "<div>X {{ msg }}</div>", newText: "<div>Y {{ msg }}</div>" },
          { oldText: "ref(0)", newText: "ref(7)" },
        ],
      };
      const component = edit.renderResult!(
        result,
        { expanded: true, isPartial: false },
        buildFakeTheme({ syntaxColors: true }),
        rctx,
      ) as unknown as TextDouble;
      const out = await component.previewTask!.render(120);
      // The script hunk's row carries token colors: token boundaries split
      // the text, so count the color CHUNKS on the const rows (an
      // unseeded/plain render has none).
      const constRows = out.split("\n").filter((l) => l.includes("const"));
      // Split view pairs del/add halves on ONE physical row, unified shows
      // two — either way the row(s) must carry token colors.
      expect(constRows.length).toBeGreaterThanOrEqual(1);
      // eslint-disable-next-line no-control-regex -- counting the theme's color escapes
      const chunks = constRows.map((l) => (l.match(/\x1b\[38;2;/g) ?? []).length);
      expect(Math.max(...chunks)).toBeGreaterThan(1);
    },
  );
});

describe("vue edit result coloring — long file, mid-file change", () => {
  it(
    "colors the changed script line with NO tags anywhere in the window",
    { timeout: 30000 },
    async () => {
      vol.writeFileSync(`${CWD}/long.vue`, LONG_VUE);
      const tools = await registerTools({ cwd: CWD });
      const edit = toolOf(tools, "edit");
      const result = await edit.execute!(
        "t-mid",
        {
          path: `${CWD}/long.vue`,
          edits: [{ oldText: "const value30 = ref(30);", newText: "const value30 = ref(777);" }],
        },
        undefined,
        undefined,
        undefined,
      );
      const mc = makeRenderCtx();
      mc.ctx.args = {
        path: `${CWD}/long.vue`,
        edits: [{ oldText: "const value30 = ref(30);", newText: "const value30 = ref(777);" }],
      };
      const component = edit.renderResult!(
        result,
        { expanded: true, isPartial: false },
        buildFakeTheme({ syntaxColors: true }),
        mc.ctx,
      ) as unknown as TextDouble;
      const out = await component.previewTask!.render(140);
      const row = out.split("\n").find((l) => l.includes("value30"));
      // eslint-disable-next-line no-control-regex -- counting color escapes
      const chunks = (row?.match(/\x1b\[38;2;/g) ?? []).length;
      expect(chunks).toBeGreaterThan(1);
    },
  );
});

describe("the seed memo's lifetime (per row, not per file)", () => {
  // Render one edit call and hand back its row state + rendered preview.
  const runEdit = async (path: string, oldText: string, newText: string) => {
    const tools = await registerTools({ cwd: CWD });
    const edit = toolOf(tools, "edit");
    const args = { path, edits: [{ oldText, newText }] };
    const result = await edit.execute!("t-seq", args, undefined, undefined, undefined);
    const mc = makeRenderCtx();
    mc.ctx.args = args;
    const component = edit.renderResult!(
      result,
      { expanded: true, isPartial: false },
      buildFakeTheme({ syntaxColors: true }),
      mc.ctx,
    ) as unknown as TextDouble;
    const out = await component.previewTask!.render(140);
    return { state: mc.ctx.state, out };
  };

  it(
    "a second edit of the same file seeds from the file WITH the first edit applied",
    { timeout: 30000 },
    async () => {
      const path = `${CWD}/seq.vue`;
      const first = "const alpha = ref(1);";
      const second = "const beta = ref(2);";
      vol.writeFileSync(path, vue(first, second));

      const a = await runEdit(path, first, first.replace("ref(1)", "ref(11)"));
      const b = await runEdit(path, second, second.replace("ref(2)", "ref(22)"));

      // Each call is its own row with its own read: A read right after its
      // own edit (the first change present, the second not yet), B read
      // after both. A shared/global memo would give B A's older read — the
      // first assertion pair pins the freshness ordering.
      expect(linesOfState(a.state)).toContain("ref(11)");
      expect(linesOfState(a.state)).not.toContain("ref(22)");
      expect(linesOfState(b.state)).toContain("ref(11)");
      expect(linesOfState(b.state)).toContain("ref(22)");
      expect(a.state).not.toBe(b.state);
      expect(plain(a.out)).toContain("ref(11)");
      expect(plain(b.out)).toContain("ref(22)");
    },
  );

  it(
    "one row's seed is frozen: a later disk change does not rewrite it",
    { timeout: 30000 },
    async () => {
      const path = `${CWD}/frozen.vue`;
      const hunk = "const gamma = ref(3);";
      vol.writeFileSync(path, vue(hunk));

      const tools = await registerTools({ cwd: CWD });
      const edit = toolOf(tools, "edit");
      const args = { path, edits: [{ oldText: hunk, newText: hunk.replace("ref(3)", "ref(33)") }] };
      const result = await edit.execute!("t-frozen", args, undefined, undefined, undefined);
      const mc = makeRenderCtx();
      mc.ctx.args = args;
      const theme = buildFakeTheme({ syntaxColors: true });
      const first = edit.renderResult!(
        result,
        { expanded: true, isPartial: false },
        theme,
        mc.ctx,
      ) as unknown as TextDouble;
      await first.previewTask!.render(140);
      const read = (mc.ctx.state as { seedLines?: string[] }).seedLines;
      expect(read?.join("\n")).toContain("ref(33)");

      // The row re-renders (expand, theme swap, resize — the SDK re-runs
      // renderResult with the SAME ctx.state). The frozen diff's prefix
      // pairs with the file as its own edit left it: the later write must
      // not bleed in, and the read must not repeat (no stat, no re-read).
      vol.writeFileSync(path, vue("const later = ref(9);"));
      const again = edit.renderResult!(
        result,
        { expanded: true, isPartial: false },
        theme,
        mc.ctx,
      ) as unknown as TextDouble;
      await again.previewTask!.render(140);
      expect((mc.ctx.state as { seedLines?: string[] }).seedLines).toBe(read);
      expect((mc.ctx.state as { seedLines?: string[] }).seedLines?.join("\n")).not.toContain(
        "ref(9)",
      );
    },
  );
});

describe("the seed gate (only embedding grammars read the file)", () => {
  it("a TypeScript edit never touches the disk for a seed", { timeout: 30000 }, async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `const value${i} = call(a${i});`);
    vol.writeFileSync(`${CWD}/plain.ts`, rows.join("\n"));
    const tools = await registerTools({ cwd: CWD });
    const edit = toolOf(tools, "edit");
    const result = await edit.execute!(
      "t-ts",
      {
        path: `${CWD}/plain.ts`,
        edits: [{ oldText: rows[40]!, newText: rows[40]!.replace("call", "invoke") }],
      },
      undefined,
      undefined,
      undefined,
    );
    const mc = makeRenderCtx();
    mc.ctx.args = {
      path: `${CWD}/plain.ts`,
      edits: [{ oldText: rows[40]!, newText: rows[40]!.replace("call", "invoke") }],
    };
    const component = edit.renderResult!(
      result,
      { expanded: true, isPartial: false },
      buildFakeTheme({ syntaxColors: true }),
      mc.ctx,
    ) as unknown as TextDouble;
    const out = await component.previewTask!.render(140);
    // TypeScript embeds nothing: the seed producer is never built, so
    // the row state carries no read at all (not even a failed one).
    expect(mc.ctx.state.seedLines).toBeUndefined();
    expect(out).toContain("invoke");
  });

  it("an oversized vue prefix degrades to the unseeded render", { timeout: 60000 }, async () => {
    const HUNK = "const target = ref(1);";
    // Enough rows that the prefix provably crosses the cap.
    const overCapRows = Math.ceil(MAX_SEED_CHARS / padRow(1234).length) + 50;
    const tail = ["import { ref } from 'vue';", HUNK];
    const vueWith = (scriptRows: number): string =>
      [
        "<template>",
        ...Array.from({ length: 5 }, (_, i) => `  <p>item ${i}</p>`),
        "</template>",
        "",
        '<script setup lang="ts">',
        ...Array.from({ length: scriptRows }, (_, i) => padRow(i)),
        ...tail,
        "</script>",
      ].join("\n");

    const run = async (name: string, scriptRows: number) => {
      const path = `${CWD}/${name}.vue`;
      vol.writeFileSync(path, vueWith(scriptRows));
      const tools = await registerTools({ cwd: CWD });
      const edit = toolOf(tools, "edit");
      const result = await edit.execute!(
        `t-${name}`,
        { path, edits: [{ oldText: HUNK, newText: HUNK.replace("ref(1)", "ref(9)") }] },
        undefined,
        undefined,
        undefined,
      );
      const mc = makeRenderCtx();
      mc.ctx.args = {
        path,
        edits: [{ oldText: HUNK, newText: HUNK.replace("ref(1)", "ref(9)") }],
      };
      const component = edit.renderResult!(
        result,
        { expanded: true, isPartial: false },
        buildFakeTheme({ syntaxColors: true }),
        mc.ctx,
      ) as unknown as TextDouble;
      const out = await component.previewTask!.render(140);
      const row = out.split("\n").find((l) => l.includes("target")) ?? "";
      // eslint-disable-next-line no-control-regex -- counting color escapes
      const chunks = (row.match(/\x1b\[38;2;/g) ?? []).length;
      return { chunks, read: Array.isArray(mc.ctx.state.seedLines) };
    };

    // A ~1200-byte prefix: the seed lands and the embedded script colors in.
    const seeded = await run("short", 30);
    expect(seeded.read).toBe(true);
    expect(seeded.chunks).toBeGreaterThan(1);

    // A prefix past MAX_SEED_CHARS: the file is still read (the memo is
    // keyed by the row, not the size), but the prefix past the cap is
    // dropped and the hunk renders unseeded — flat next to the seeded
    // run's chunk count.
    const capped = await run("huge", overCapRows);
    expect(capped.read).toBe(true);
    expect(capped.chunks).toBeLessThan(seeded.chunks);
  });
});
