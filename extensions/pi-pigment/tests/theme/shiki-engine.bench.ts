import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
/**
 * The shiki engine benchmark: warm and cold `codeToTokensBase` under the
 * JavaScript-regex engine (oniguruma-to-es, the pre-migration default) vs
 * the Oniguruma WASM engine (shiki's Node default and the canonical
 * TextMate reference — VS Code/vscode-textmate's engine).
 *
 * ONE engine per process, selected by BENCH_ENGINE:
 * BENCH_ENGINE=js   pnpm vitest bench tests/theme/shiki-engine.bench.ts
 * BENCH_ENGINE=onig pnpm vitest bench tests/theme/shiki-engine.bench.ts
 * (default: the source's engine — "onig" since the migration landed).
 *
 * Why not A/B both cores in one bench file: measured side-by-side in one
 * heap, the ratio collapses to ~1.35x with run-to-run flips — the second
 * engine inherits the first's GC pressure/JIT layout, and production never
 * runs two engines in one process anyway. Across fresh processes (the
 * production shape), four independent probe designs agree: cold ~3-4x and
 * warm ~5x at 29-88KB TS. Keep the separation; compare across two runs.
 *
 * The cold leg measures the first tokenize after language load (the
 * JS-engine lazy-regex-compile premium — ~595ms at 29KB — lives there);
 * the warm legs loop the steady-state matching cost. Both bounds matter:
 * cold is the per-language first block of a session, warm is every
 * theme-switch re-render.
 *
 * Benchmarks live inside `test()` as the `bench` context fixture;
 * `.bench.ts` files are skipped by `vitest run` and measured via
 * `pnpm vitest bench`.
 *
 * Every benchmark folds its return value into a running sink so the
 * engine cannot eliminate the measured work (dead-code elimination).
 */
import { beforeAll, test } from "vitest";

// The realistic fixture: the renderer's own source, raw-imported (the
// word-diff module — dense real-world code). Dense
// real-world code (long lines, token-heavy) is REQUIRED — synthetic
// generated fixtures of short lines hide the JS engine's superlinear
// line-length cost and shrink the measured ratio to ~1.2x.
// oxlint-disable-next-line import/default
import tsReal from "#src/render/word-diff.ts?raw";

const ENGINE: "js" | "onig" =
  process.env.BENCH_ENGINE === "js" ? "js" : process.env.BENCH_ENGINE === "onig" ? "onig" : "onig";

/** The C++ outlier (its grammar is the documented worst case, #893). */
const cppCode = `#include <vector>
#include <string>
namespace test {
template <typename T> class Foo {
public:
  Foo(T v) : value(v) {}
  auto get() const -> T { return value; }
  template <typename U> U convert() const { return static_cast<U>(value); }
private:
  T value;
};
int main() {
  std::vector<std::string> xs = {"a", "bb", "ccc"};
  for (const auto &x : xs) { if (x.size() > 1) printf("%s\\n", x.c_str()); }
  return 0;
}
`;

// Bound inputs (module getters would dominate nanosecond-scale benches).
const _ts3 = tsReal.slice(0, 3000);
const _ts29 = tsReal;
const _ts80 = `${tsReal}\n${tsReal}\n${tsReal}`;
const _cpp = cppCode;

/**
 * One minimal theme (identical registration per engine — theme application
 * is engine-independent shared code; the full nord theme's 250+ settings
 * shift absolute numbers but not the engine ratio).
 */
const minimalTheme = {
  name: "bench-min",
  type: "dark",
  settings: [
    { settings: { foreground: "#d4d4d4" } },
    { scope: ["keyword", "storage.type"], settings: { foreground: "#569cd6", fontStyle: 2 } },
    { scope: ["string"], settings: { foreground: "#ce9178" } },
    { scope: ["comment"], settings: { foreground: "#6a9955", fontStyle: 1 } },
    { scope: ["function", "entity.name.function"], settings: { foreground: "#dcdcaa" } },
    { scope: ["variable"], settings: { foreground: "#9cdcfe" } },
    { scope: ["constant.numeric"], settings: { foreground: "#b5cea8" } },
    { scope: ["type", "entity.name.type"], settings: { foreground: "#4ec9b0" } },
    { scope: ["operator", "punctuation"], settings: { foreground: "#d4d4d4" } },
  ],
};

// One module-level sink absorbs every measured return value (DCE guard).
let sink = 0;

let core: HighlighterCore;

beforeAll(async () => {
  if (ENGINE === "js") {
    core = await createHighlighterCore({ engine: createJavaScriptRegexEngine() });
  } else {
    core = await createHighlighterCore({
      engine: await createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  await core.loadLanguage(
    (await import(/* @vite-ignore */ `shiki/dist/langs/typescript.mjs`)).default,
  );
  await core.loadLanguage((await import(/* @vite-ignore */ `shiki/dist/langs/cpp.mjs`)).default);
  await core.loadTheme(minimalTheme as never);
  // The first tokenize per language carries the engine-init premium; the
  // warm benches below must not. Warm both languages before timing.
  await core.codeToTokensBase(_ts3, { lang: "typescript", theme: "bench-min" });
  await core.codeToTokensBase(_cpp, { lang: "cpp", theme: "bench-min" });
});

const tokenThere = (tokens: { content: string }[][]): number =>
  tokens.reduce((n, line) => n + line.length, 0);

test(`shiki ${ENGINE} engine (warm tokenize)`, { timeout: 300_000 }, async ({ bench }) => {
  const _core = core;
  await bench("ts 3kb", async () => {
    sink += tokenThere(
      await _core.codeToTokensBase(_ts3, { lang: "typescript", theme: "bench-min" }),
    );
  }).run();
  await bench("ts 29kb", async () => {
    sink += tokenThere(
      await _core.codeToTokensBase(_ts29, { lang: "typescript", theme: "bench-min" }),
    );
  }).run();
  await bench("ts 80kb", async () => {
    sink += tokenThere(
      await _core.codeToTokensBase(_ts80, { lang: "typescript", theme: "bench-min" }),
    );
  }).run();
  await bench("cpp ~2.5kb", async () => {
    sink += tokenThere(await _core.codeToTokensBase(_cpp, { lang: "cpp", theme: "bench-min" }));
  }).run();
});
