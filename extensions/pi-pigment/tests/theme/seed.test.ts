import { describe, expect, it } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { detectLanguage } from "#src/theme/language.ts";
import {
  lastHunkNewStart,
  MAX_SEED_CHARS,
  needsSeed,
  seedFromLines,
  seedFromText,
} from "#src/theme/seed.ts";

describe("seed lifecycle (seed.ts)", () => {
  it("gates on embedded grammars", () => {
    expect(needsSeed("vue")).toBe(true);
    expect(needsSeed("typescript")).toBe(false);
    expect(needsSeed(undefined)).toBe(false);
  });

  it("slices the last hunk's prefix, view-independent", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `row${i}`);
    const oldText = `${rows.join("\n")}\n`;
    const changed = [...rows];
    changed[2] = "CHANGED near top";
    changed[50] = "CHANGED deep";
    const newText = `${changed.join("\n")}\n`;
    const diff = parseDiff(oldText, newText);
    const start = lastHunkNewStart(diff);
    expect(start).toBeGreaterThan(10);
    const seed = seedFromText(newText, "vue")?.(start);
    expect(seed).toBeDefined();
    expect(seed).toContain("CHANGED near top");
    expect(seed).not.toContain("CHANGED deep");
  });

  it("returns undefined at/before line 1", () => {
    expect(seedFromText("a\nb\n", "vue")?.(1)).toBeUndefined();
    expect(seedFromLines(() => ["a", "b"], "vue")?.(1)).toBeUndefined();
  });

  it("returns undefined for non-seed languages", () => {
    expect(seedFromText("a\nb\n", "typescript")).toBeUndefined();
    expect(seedFromLines(() => ["a"], "typescript")).toBeUndefined();
  });

  it("drops oversized prefixes at the source", () => {
    const big = `${"x".repeat(MAX_SEED_CHARS + 1)}\n tail\n`;
    expect(seedFromText(big, "vue")?.(2)).toBeUndefined();
  });

  it("lastHunkNewStart falls back to 1 without hunks", () => {
    expect(lastHunkNewStart({ lines: [], added: 0, removed: 0 })).toBe(1);
  });
});

describe("detectLanguage", () => {
  it("maps extensions through the SDK's map, Shiki's keys, and the header extras", () => {
    // The SDK's own extension map is the first authority.
    expect(detectLanguage("src/app.ts")).toBe("typescript");
    expect(detectLanguage("script.mjs")).toBe("javascript");
    expect(detectLanguage("header.h")).toBe("c");
    expect(detectLanguage("header.hpp")).toBe("cpp");
    expect(detectLanguage("impl.cc")).toBe("cpp");
    expect(detectLanguage("run.zsh")).toBe("bash");
    // Extensionless convention files match their whole (lowercased) name.
    expect(detectLanguage("Makefile")).toBe("makefile");
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    // Shiki's key set covers the newer extensions the SDK map lacks.
    expect(detectLanguage("main.zig")).toBe("zig");
    expect(detectLanguage("cli.nu")).toBe("nu");
    expect(detectLanguage("style.scss")).toBe("scss");
    // The two header spellings neither carries.
    expect(detectLanguage("impl.hxx")).toBe("cpp");
    expect(detectLanguage("impl.hh")).toBe("cpp");
    // Non-language words stay undefined.
    expect(detectLanguage("noext")).toBeUndefined();
    expect(detectLanguage("README")).toBeUndefined();
    expect(detectLanguage("app")).toBeUndefined();
  });
});

describe("needsSeed (the grammar-seed gate)", () => {
  it("admits the grammars that embed another syntax", () => {
    for (const path of [
      "app.vue",
      "App.svelte",
      "page.astro",
      "index.html",
      "notes.md",
      "doc.mdx",
      "index.php",
      "view.erb",
      "template.hbs",
      "page.liquid",
    ]) {
      expect(needsSeed(detectLanguage(path))).toBe(true);
    }
  });

  it("turns away languages whose tokenize a seed cannot change", () => {
    // tsx/jsx carry JSX inside the TS/JS grammar itself — the tag-looking
    // syntax is not an embedded grammar, so no seed is warranted.
    for (const path of [
      "app.ts",
      "main.tsx",
      "view.jsx",
      "script.py",
      "main.go",
      "lib.rs",
      "data.json",
      "conf.yaml",
      "style.css",
      "noext",
    ]) {
      expect(needsSeed(detectLanguage(path))).toBe(false);
    }
    expect(needsSeed(undefined)).toBe(false);
  });
});
