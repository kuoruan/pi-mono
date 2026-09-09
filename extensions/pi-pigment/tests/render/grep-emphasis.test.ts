import { describe, expect, it } from "vitest";

import { emphasize, riskyPattern } from "#src/render/pattern-emphasis.ts";
import { parseHitLine, renderHitLine } from "#src/render/tool-grep.ts";
import { FALLBACK_PALETTE, resolveDiffPalette } from "#src/theme/palette.ts";
import { buildFakeTheme, buildRenderTheme } from "#test/fixtures.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const FG_DEFAULT = "\x1b[39m";
const STR_FG = "\x1b[38;2;220;220;170m"; // a syntax-string color
/** The emphasis spec callers pass: bold + an independent accent fg. */
const EMPHASIS = { fg: "\x1b[38;2;255;170;0m" };

describe("riskyPattern (ReDoS gate)", () => {
  it("flags quantified groups that can match one text multiple ways", () => {
    const misflagged = [
      "(a+)+b",
      "(a|a)*b",
      "(a*)*b",
      "(\\w+)+$",
      "(.*)*x",
      "(a|ab)+c",
      "([a-z]+)+x",
      "(a?)+",
      "(a{2,3}){2,3}",
      "((a)*)*",
      "(a|b|c)+",
      "(?:(a|b))+",
      "a(b+c)+d",
    ].filter((p) => !riskyPattern(p));
    expect(misflagged).toEqual([]);
  });

  it("passes linear patterns through (the common grep shapes)", () => {
    const flagged = [
      "a+b",
      "[abc]+",
      "(foo|bar)baz",
      "(foo)+",
      "^\\s*function",
      "TODO|FIXME",
      "\\d{2,4}",
      "(a)(b)(c)",
      "(?:ab)+",
      "a{2,3}",
      "\\(a\\)+",
      "[(]+",
      "(x)*",
      "\\bword\\b",
      "src/[a-z]+\\.ts",
      "(?!a)+",
    ].filter((p) => riskyPattern(p));
    expect(flagged).toEqual([]);
  });

  it("treats any backreference as risky (NP-hard matching)", () => {
    expect(riskyPattern("(a|b)\\1+")).toBe(true);
    expect(riskyPattern("\\1")).toBe(true);
  });
});

describe("renderHitLine (plain-text hit lines carry their own fg)", () => {
  it("opens the content fg and re-opens it after each match (M1 regression)", () => {
    const hit = parseHitLine("src/a.ts:1: const aa = 1; // aa");
    expect(hit).not.toBeNull();
    const theme = buildRenderTheme();
    const palette = resolveDiffPalette(buildFakeTheme());
    const out = renderHitLine({
      hit: hit!,
      content: "const aa = 1; // aa",
      pattern: "aa",
      flags: { literal: true, ignoreCase: false },
      theme,
      palette,
    });
    // The content opens with the toolOutput fg (the plain-text path has
    // no token spans to carry one — without this, the muted prefix bled
    // into the content and the first match's close left the rest on the
    // terminal default).
    expect(out).toContain(theme.getFgAnsi("toolOutput"));
    // The emphasis wrap closes CHANNEL-SCOPED (bold off) and re-opens the
    // content fg: the text AFTER the match keeps the toolOutput color.
    expect(out).toContain(`${BOLD_OFF}${theme.getFgAnsi("toolOutput")}`);
    // The line ends with the channel-scoped fg close — a full RESET is
    // gone from the emission path (it would kill pi's line-level frame
    // canvas from the match onward — the tool-ls rule).
    expect(out).not.toContain(RESET);
    expect(out.endsWith(FG_DEFAULT)).toBe(true);
  });
});

describe("emphasize (grep hit emphasis)", () => {
  it("skips regex emphasis for risky patterns (graceful degradation)", () => {
    // (a+)+b hangs JS while ripgrep answers instantly; emphasis must not
    // run it at all — content passes through with syntax colors intact.
    const content = `${STR_FG}aaaab${RESET}`;
    const out = emphasize({
      content,
      pattern: "(a+)+b",
      flags: { literal: false, ignoreCase: false },
      emphasis: EMPHASIS,
    });
    expect(out).toBe(content);
  });

  it("re-opens the span's fg after each hit", () => {
    const content = `${STR_FG}abcabc${RESET}`;
    const out = emphasize({
      content,
      pattern: "abc",
      flags: { literal: false, ignoreCase: false },
      emphasis: EMPHASIS,
    });
    // After each hit's channel-scoped close (bold off), the string color
    // resumes for the rest. The wrap is BOLD + accent (the CLI convention
    // — visible even where the accent overlaps a token color); the
    // content's own trailing RESET passes through untouched.
    expect(out).toBe(
      `${STR_FG}${BOLD}${EMPHASIS.fg}abc${BOLD_OFF}${STR_FG}${BOLD}${EMPHASIS.fg}abc${BOLD_OFF}${STR_FG}${RESET}`,
    );
  });

  it("closes bold-only and falls back to the fg default without a span fg", () => {
    const out = emphasize({
      content: "Find find FIND",
      pattern: "find",
      flags: { literal: true, ignoreCase: true },
      emphasis: EMPHASIS,
    });
    // No span fg active (plain content): each hit closes bold, then the
    // fg default — never a full reset (the frame canvas must survive).
    expect(out).toBe(
      `${BOLD}${EMPHASIS.fg}Find${BOLD_OFF}${FG_DEFAULT} ${BOLD}${EMPHASIS.fg}find${BOLD_OFF}${FG_DEFAULT} ${BOLD}${EMPHASIS.fg}FIND${BOLD_OFF}${FG_DEFAULT}`,
    );
  });
});

describe("renderHitLine prefix coloring", () => {
  const MUTED = "\x1b[38;2;110;110;120m";
  const theme = {
    fg: () => "",
    getFgAnsi: (name: string) => (name === "muted" ? MUTED : ""),
  } as never;

  it('hit prefixes open the muted escape (fg(name, "") is a visual no-op)', () => {
    const out = renderHitLine({
      hit: { prefix: "src/app.ts:12:", content: "const x = 1;", isContext: false },
      content: "const x = 1;",
      pattern: "",
      flags: { literal: false, ignoreCase: false },
      theme,
      palette: FALLBACK_PALETTE,
    });
    expect(out.startsWith(MUTED)).toBe(true);
  });

  it("context prefixes stay dim", () => {
    const out = renderHitLine({
      hit: { prefix: "src/app.ts-12-", content: "const x = 1;", isContext: true },
      content: "const x = 1;",
      pattern: "",
      flags: { literal: false, ignoreCase: false },
      theme,
      palette: FALLBACK_PALETTE,
    });
    expect(out.startsWith(FALLBACK_PALETTE.fgDim)).toBe(true);
  });

  it("skips empty regex matches (an x* pattern must not wrap every position)", () => {
    // A pattern that matches empty at every position: without the skip,
    // each position injects ~20 bytes of SGR wrap around nothing.
    const out = emphasize({
      content: "abcdef",
      pattern: "x*",
      flags: { literal: false, ignoreCase: false },
      emphasis: EMPHASIS,
    });
    // No emphasis spans at all — and no escape bloat beyond the source.
    expect(out).toBe("abcdef");
  });

  it("emits channel-scoped closes only — no full reset, no background escapes", () => {
    // The wrap must never kill pi's line-level frame canvas: a full RESET
    // or an inline bg escape would expose the terminal default background
    // from the match onward (the tool-ls channel-scoped rule).
    const content = `${STR_FG}Find find FIND`;
    const out = emphasize({
      content,
      pattern: "find",
      flags: { literal: true, ignoreCase: true },
      emphasis: EMPHASIS,
      baseFg: STR_FG,
    });
    // eslint-disable-next-line no-control-regex -- matches the escape classes the wrap must not emit
    expect(out).not.toMatch(/\x1b\[0m/);
    // eslint-disable-next-line no-control-regex -- matches the background escapes the wrap must not emit
    expect(out).not.toMatch(/\x1b\[4[89]/);
    expect(out).toContain(BOLD_OFF);
  });
});
