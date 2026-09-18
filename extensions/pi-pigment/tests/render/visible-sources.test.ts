import { describe, expect, it } from "vitest";

import { parseDiff } from "#src/core/diff.ts";
import { splitWindow, unifiedWindow } from "#src/render/visible-sources.ts";

const oldText = "a\nb\nc\nd\ne\nf\ng\nh\n";
const newText = "a\nB\nc\nd\ne\nF\ng\nh\n";

describe("visible-sources (window + highlight alignment)", () => {
  it("unified: sources mirror the visible rows in order", () => {
    const diff = parseDiff(oldText, newText);
    const { visible, oldSource, newSource } = unifiedWindow(diff.lines, 100);
    expect(visible.length).toBeGreaterThan(0);
    // Same row order: ctx in both, del only old, add only new.
    const oldExpected: string[] = [];
    const newExpected: string[] = [];
    for (const line of visible) {
      if (line.type === "ctx" || line.type === "del") oldExpected.push(line.content);
      if (line.type === "ctx" || line.type === "add") newExpected.push(line.content);
    }
    expect(oldSource).toEqual(oldExpected);
    expect(newSource).toEqual(newExpected);
  });

  it("split: left/right sources mirror the visible rows in order", () => {
    const diff = parseDiff(oldText, newText);
    const { rows, visible, leftSource, rightSource } = splitWindow(diff.lines, 100);
    expect(rows.length).toBeGreaterThanOrEqual(visible.length);
    // Every non-sep side content lands in its source exactly once.
    const leftExpected: string[] = [];
    const rightExpected: string[] = [];
    for (const row of visible) {
      if (row.left && row.left.type !== "sep") leftExpected.push(row.left.content);
      if (row.right && row.right.type !== "sep") rightExpected.push(row.right.content);
    }
    expect(leftSource).toEqual(leftExpected);
    expect(rightSource).toEqual(rightExpected);
  });

  it("split pairs before slicing: maxLines counts rows, not lines", () => {
    const diff = parseDiff(oldText, newText);
    const full = splitWindow(diff.lines, 10_000);
    const one = splitWindow(diff.lines, 1);
    expect(one.visible.length).toBe(1);
    expect(one.rows.length).toBe(full.rows.length);
  });
});
