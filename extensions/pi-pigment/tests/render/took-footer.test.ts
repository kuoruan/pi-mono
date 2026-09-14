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
import { buildRenderTheme, plain } from "#test/fixtures.ts";

describe("tookFooter (pretty-ms delegation)", () => {
  it("is empty when the duration is unknown", () => {
    expect(tookFooter(undefined, buildRenderTheme())).toBe("");
  });

  it("formats the common ranges", () => {
    const theme = buildRenderTheme();
    expect(plain(tookFooter(8, theme))).toBe("Took 8ms");
    expect(plain(tookFooter(999, theme))).toBe("Took 999ms");
    expect(plain(tookFooter(1234, theme))).toBe("Took 1.2s");
    expect(plain(tookFooter(9500, theme))).toBe("Took 9.5s");
  });

  // pretty-ms owns every rounding boundary; these pin the delegation, not
  // the arithmetic (CONTEXT.md: upstream keeps the rounding correct).
  it("formats long runs readably", () => {
    const theme = buildRenderTheme();
    expect(plain(tookFooter(65_000, theme))).toBe("Took 1m 5s");
    expect(plain(tookFooter(2_760_000, theme))).toBe("Took 46m");
    expect(plain(tookFooter(3_722_000, theme))).toBe("Took 1h 2m 2s");
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
