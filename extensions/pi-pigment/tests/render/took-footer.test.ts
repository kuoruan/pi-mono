import { describe, expect, it } from "vitest";

import { tookFooter } from "#src/render/tool-output.ts";
import { buildRenderTheme, plain } from "#test/fixtures.ts";

describe("tookFooter (pretty-ms delegation)", () => {
  it("renders nothing when unmeasured", () => {
    expect(tookFooter(undefined, buildRenderTheme())).toBe("");
  });

  it("keeps the common range's shape: integer ms below 1s, one decimal above", () => {
    const theme = buildRenderTheme();
    expect(plain(tookFooter(8, theme))).toBe("Took 8ms");
    expect(plain(tookFooter(999, theme))).toBe("Took 999ms");
    expect(plain(tookFooter(1234, theme))).toBe("Took 1.2s");
    expect(plain(tookFooter(9500, theme))).toBe("Took 9.5s");
  });

  it("reads minute-scale runs as minutes and hours", () => {
    const theme = buildRenderTheme();
    expect(plain(tookFooter(65_000, theme))).toBe("Took 1m 5s");
    expect(plain(tookFooter(2_760_000, theme))).toBe("Took 46m");
    expect(plain(tookFooter(3_722_000, theme))).toBe("Took 1h 2m 2s");
  });
});
