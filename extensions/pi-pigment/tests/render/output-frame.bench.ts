/**
 * The output wrappers' per-trigger-frame cost: a settled grep renderResult
 * runs on EVERY updateDisplay cycle, and its body rebuilds the plain
 * placeholder (collapsedView + renderPlainOutput + join) even when the
 * attach guard will discard it — the placeholder is only consumed when
 * the identity changes. This bench drives the settled shape for real: one
 * registered grep, ONE result object referenced every iteration (the
 * production settle semantics — replacing the result each frame would
 * miss the derive memo and measure a frame that never occurs), an
 * invalidation counter that counts without repainting.
 *
 * Benchmarks live inside `test()` as the `bench` context fixture;
 * `.bench.ts` files are skipped by `vitest run` and measured via
 * `pnpm vitest bench`.
 *
 * Every benchmark folds its return value into a running sink so the
 * engine cannot eliminate the measured work (dead-code elimination).
 */
import { beforeAll, test } from "vitest";

import { buildRenderTheme, makeRenderCtx, registerTools } from "#test/fixtures.ts";

// One module-level sink absorbs every measured return value (DCE guard).
let sink = 0;

let renderResult: NonNullable<Awaited<ReturnType<typeof registerTools>>[number]["renderResult"]>;
let ctx: ReturnType<typeof makeRenderCtx<object>>["ctx"];
let theme: ReturnType<typeof buildRenderTheme>;
let result: unknown;

beforeAll(async () => {
  const tools = await registerTools({});
  const grep = tools.find((t) => t.name === "grep");
  if (!grep?.renderResult) throw new Error("grep not registered");
  renderResult = grep.renderResult.bind(grep);
  const made = makeRenderCtx<object>();
  ctx = made.ctx;
  ctx.args = { pattern: "value" };
  theme = buildRenderTheme();
  const output = Array.from(
    { length: 12 },
    (_, i) => `src/file${i}.ts:${i + 1}: const value${i} = compute(${i});`,
  ).join("\n");
  result = {
    content: [{ type: "text", text: output }],
    isError: false,
  };
  // First frame (identity attaches); the bench measures settled repeats.
  renderResult(result, { expanded: true, isPartial: false }, theme, ctx);
});

test("settled grep renderResult per trigger frame", async ({ bench }) => {
  await bench("repeat renderResult with the same settled result", () => {
    const component = renderResult(
      result,
      {
        expanded: true,
        isPartial: false,
      },
      theme,
      ctx,
    ) as { text: { text: string } };
    sink += component.text.text.length;
  }).run();
});
