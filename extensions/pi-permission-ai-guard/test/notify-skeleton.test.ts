import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The notify skeleton, mechanically enforced: no structural colons in any
 * static notify text. The TUI prefixes its own level ("Warning: …") — a
 * colon inside our line doubles up. Detail rides in parentheses or after
 * an em-dash; a URL scheme ("https://…") is not structural. Scans the
 * notify-producing sources so a copy edit cannot reintroduce the shape.
 */
const NOTIFY_SOURCES = [
  "src/session-lifecycle.ts",
  "src/review-pipeline.ts",
  "src/runtime-settings.ts",
  "src/verdict-mode.ts",
] as const;

describe("notify skeleton — no structural colons", () => {
  it("every static notify literal is colon-free", () => {
    const offenders: string[] = [];
    for (const f of NOTIFY_SOURCES) {
      const s = readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");
      for (const m of s.matchAll(
        /(?:deps\.notify|feedbackNotify|this\.#deps\.notify)\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g,
      )) {
        const staticText = m[1]!.replaceAll(/\$\{[^}]*\}/g, "");
        if (/:\s/.test(staticText) && !staticText.includes("http")) {
          offenders.push(`${f}: ${JSON.stringify(staticText.slice(0, 60))}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
