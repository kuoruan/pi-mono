import { afterEach, describe, expect, it, vi } from "vitest";

import { warn } from "#src/logger.ts";

describe("logger", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  it("warn writes a [pi-permission-ai-guard]-prefixed line to console.warn", () => {
    warn("something is off");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[pi-permission-ai-guard] something is off");
  });
});
