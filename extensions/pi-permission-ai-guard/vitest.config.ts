import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Persist the transform cache across runs: local reruns skip most of
    // the module-graph transform cost; CI (fresh checkout) is unaffected
    // either way.
    fsModuleCache: true,
  },
  resolve: {
    alias: {
      "#src": fileURLToPath(new URL("./src/", import.meta.url)),
      "#test": fileURLToPath(new URL("./tests/", import.meta.url)),
    },
  },
});
