import { getCapabilities } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  formatToolFrameHeaderText,
  formatToolHeaderName,
  formatToolHeaderPath,
  resultLine,
} from "#src/render/header.ts";

describe("tool header names", () => {
  it("prefixes write and edit with a left arrow", () => {
    expect(formatToolHeaderName("write")).toBe("← write");
    expect(formatToolHeaderName("create")).toBe("← create");
    expect(formatToolHeaderName("edit")).toBe("← edit");
    expect(formatToolHeaderName("read")).toBe("read");
  });

  it("composes result lines: indent + space-joined segments, empties drop", () => {
    expect(resultLine()).toBe("");
    expect(resultLine("")).toBe("");
    expect(resultLine(undefined)).toBe("");
    expect(resultLine("a")).toBe(" a");
    expect(resultLine("a", "b")).toBe(" a b");
    // The streaming-count + bridged-summary shape (write): the summary
    // segment may be absent mid-stream and appears later without the
    // caller re-stripping any indent.
    expect(resultLine("(2 lines…)", "")).toBe(" (2 lines…)");
    expect(resultLine("(2 lines…)", "✓ new file (2 lines)")).toBe(
      " (2 lines…) ✓ new file (2 lines)",
    );
  });

  it("uses toolTitle for tool header paths (OSC-8 linked when capable)", () => {
    const theme = { fg: (name: string, text: string) => `${name}:${text}` };
    const styled = formatToolHeaderPath(theme, "src/index.ts", (p) => p, "/repo");
    // The styled text always carries the toolTitle color; a capable
    // terminal additionally gets the file:// OSC-8 wrap around it.
    const unwrapped = styled.replace(/\]8;;[^]*\\/g, "");
    expect(unwrapped).toBe("toolTitle:src/index.ts");
    // Capable terminals additionally get the file:// OSC-8 wrap; incapable
    // ones must NOT carry a link payload.
    const linked = getCapabilities().hyperlinks;
    expect(styled.includes("file:///repo/src/index.ts")).toBe(linked);
  });

  it("frames the header line with the requested blank rows (topPad/bottomPad)", () => {
    // The call headers rely on bottomPad:1 for the blank row below the
    // header — a regression here silently fuses the header and the body.
    const meta = formatToolFrameHeaderText(
      { meta: "bash ✗ exit 1", topPad: 1, bottomPad: 2 },
      (p) => p,
    );
    expect(meta).toBe("\nbash ✗ exit 1\n\n");
    const bare = formatToolFrameHeaderText({ meta: "x" }, (p) => p);
    expect(bare).toBe("x");
  });
});
