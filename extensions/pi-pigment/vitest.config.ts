import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Persist the transform cache across runs: local reruns of a few
    // files reuse the module-graph transform instead of paying the full
    // cost again. CI (fresh checkout) is unaffected either way.
    fsModuleCache: true,
    // Parallelism note: tests/render/tool-output.test.ts carries the
    // grammar-state flake (upstream shiki tokenize nondeterminism under
    // concurrent forks — see docs/open-issues/grammar-state-flake.md).
    // Parallel stays on: the affected test self-heals inside its own
    // bounded clear-cache-and-retry loop.
    fileParallelism: true,
    // Benchmarks: `pnpm vitest bench` (vitest built-in, no new deps).
    benchmark: {
      include: ["tests/**/*.bench.ts"],
      // The bench files bind every function/input they import locally, so
      // the only remaining export-getter accesses are the ones INSIDE our
      // source graph (render-shared → core/ansi). Those cost a few ns per
      // call against 0.2-1.4µs of measured work (well under the ±1-2% rme)
      // — accepted overhead, warning suppressed deliberately.
      suppressExportGetterWarnings: true,
    },
    // Inline the SDK so its built-in imports ("fs/promises" etc.) route
    // through the vite pipeline — vi.mock can then intercept them for the
    // memfs-backed execute tests.
    server: {
      deps: {
        inline: [/@earendil-works\/pi-coding-agent/],
      },
    },
  },
  resolve: {
    alias: {
      "#src": fileURLToPath(new URL("./src/", import.meta.url)),
      "#test": fileURLToPath(new URL("./tests/", import.meta.url)),
    },
  },
});
