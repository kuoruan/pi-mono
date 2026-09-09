import { describe, expect, it } from "vitest";

import { renderTokenLinesAnsi } from "#src/theme/shiki-core.ts";

describe("renderTokenLinesAnsi (shiki-core)", () => {
  it("renders token lines in ANSI, skipping uncolored ones", () => {
    const out = renderTokenLinesAnsi([
      [
        { content: "const", color: "#F97583", fontStyle: 0, offset: 0 },
        { content: " x", color: undefined, fontStyle: 0, offset: 5 },
      ],
    ]);
    expect(out[0]).toContain("\u001b[38;2;249;117;131mconst\u001b[39m");
    expect(out[0]).toContain(" x");
  });
});
