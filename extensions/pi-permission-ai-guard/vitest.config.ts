import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "#src": fileURLToPath(new URL("./src/", import.meta.url)),
      "#test": fileURLToPath(new URL("./test/", import.meta.url)),
    },
  },
});
