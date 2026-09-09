import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Benchmarks: `pnpm vitest bench` (vitest built-in, no new deps).
    benchmark: {
      include: ["tests/**/*.bench.ts"],
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
