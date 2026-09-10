import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildFakeTheme,
  makeRenderCtx,
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

const CWD = "/render-project";

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
