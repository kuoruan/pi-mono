import { afterEach, describe, expect, it, vi } from "vitest";

import { debug, warn } from "#src/logger.ts";

describe("logger", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
    debugSpy.mockClear();
  });

  it("warn writes a [pi-permission-ai-guard]-prefixed line to console.warn", () => {
    warn("something is off");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[pi-permission-ai-guard] something is off");
  });

  it("debug writes a [pi-permission-ai-guard]-prefixed line to console.debug", () => {
    debug("verbose detail");
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("[pi-permission-ai-guard] verbose detail");
  });
});
