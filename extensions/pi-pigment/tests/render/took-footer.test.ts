/**
 * The Took footer and the execution clock behind it. The clock is pi's own
 * contract (its shell renderer arms `startedAt` in renderCall while the
 * execution is live, and fixes `endedAt` in the settled renderResult), which
 * pi-pigment drives for every wrapper — so the footer behaves exactly like
 * bash's, including showing NOTHING on a row replayed from a session.
 */
import { describe, expect, it } from "vitest";

import { armTiming, stopTiming, tookFooter } from "#src/render/tool-output.ts";
import type { ExecutionTimingState } from "#src/render/tool-services.ts";
import { buildFakeTheme, buildRenderTheme, plain } from "#test/fixtures.ts";

describe("tookFooter (pi shell-renderer parity)", () => {
  it("is empty when the duration is unknown", () => {
    expect(tookFooter(undefined, buildRenderTheme(), "muted")).toBe("");
  });

  // Same body as pi's native formatDuration: seconds with one decimal,
  // always — 8ms reads "0.0s", exactly like bash's settled row.
  it("formats every duration as seconds with one decimal", () => {
    const theme = buildRenderTheme();
    expect(plain(tookFooter(8, theme, "muted"))).toBe("Took 0.0s");
    expect(plain(tookFooter(999, theme, "muted"))).toBe("Took 1.0s");
    expect(plain(tookFooter(1234, theme, "muted"))).toBe("Took 1.2s");
    expect(plain(tookFooter(9500, theme, "muted"))).toBe("Took 9.5s");
    expect(plain(tookFooter(65_000, theme, "muted"))).toBe("Took 65.0s");
    expect(plain(tookFooter(3_722_000, theme, "muted"))).toBe("Took 3722.0s");
  });

  // The state color rides the footer: the escape matches the requested
  // slot and the body text survives plain() (which strips only SGR
  // escapes — never other characters). No adjacency pinning: only that
  // the color is present and the text is exact.
  it("takes the requested state color", () => {
    const theme = buildFakeTheme();
    for (const color of ["muted", "success", "error", "warning"] as const) {
      const footer = tookFooter(1234, theme, color);
      expect(footer).toContain(theme.getFgAnsi(color));
      expect(plain(footer)).toBe("Took 1.2s");
    }
    expect(tookFooter(undefined, theme, "success")).toBe("");
  });
});

describe("the execution clock (armTiming / stopTiming)", () => {
  it("arms only while the execution is live", () => {
    const replay: ExecutionTimingState = {};
    armTiming(replay, false);
    expect(replay.startedAt).toBeUndefined();

    const live: ExecutionTimingState = {};
    armTiming(live, true);
    expect(live.startedAt).toBeTypeOf("number");
  });

  it("keeps the first arm across repeated renderCall frames", () => {
    const state: ExecutionTimingState = {};
    armTiming(state, true);
    const first = state.startedAt;
    armTiming(state, true);
    expect(state.startedAt).toBe(first);
  });

  it("reports nothing while the result streams, then a fixed span", () => {
    const state: ExecutionTimingState = { startedAt: Date.now() - 40 };
    expect(stopTiming(state, true, false)).toBeUndefined();
    expect(state.endedAt).toBeUndefined();
    const settled = stopTiming(state, false, false);
    expect(settled).toBeGreaterThanOrEqual(40);
    // A re-render of the same row reads the SAME value (it is part of the
    // frame cache key).
    expect(stopTiming(state, false, false)).toBe(settled);
  });

  it("settles an error frame even while partial", () => {
    const state: ExecutionTimingState = { startedAt: Date.now() - 5 };
    expect(stopTiming(state, true, true)).toBeGreaterThanOrEqual(5);
  });

  it("reports nothing for a row whose clock was never armed (a replay)", () => {
    const replayed: ExecutionTimingState = {};
    expect(stopTiming(replayed, false, false)).toBeUndefined();
    // The settled render still records its end — it just has no start to
    // measure from, so no later frame can invent one.
    expect(replayed.endedAt).toBeTypeOf("number");
    expect(stopTiming(replayed, false, false)).toBeUndefined();
  });
});
