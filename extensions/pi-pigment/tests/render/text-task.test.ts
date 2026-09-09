/**
 * The width-aware render driver: getWidthAwareText's placeholder → swap →
 * stale-rejection protocol, driven through a fake Text with pi-tui's shape.
 */

import { describe, expect, it } from "vitest";

import { attachPreviewTask, clearPreviewTask, getWidthAwareText } from "#src/render/text-task.ts";

/**
 * A fresh Text-shaped host for the stale-rejection scenarios (each drive
 * needs its own component state).
 *
 * @returns The host's current text getter and the wrapped component.
 */
function makeHost(): {
  current: () => string;
  text: ReturnType<typeof getWidthAwareText>;
} {
  let current = "";
  const base = {
    setText(s: string) {
      current = s;
    },
    render: (_width: number): string[] => [current],
    invalidate: () => {},
    previewTask: undefined as unknown,
    customBgFn: undefined as unknown,
    setCustomBgFn(_fn?: (l: string) => string) {},
  };
  const text = getWidthAwareText(base, undefined as never);
  return { current: () => current, text };
}

describe("attachPreviewTask (the attach guard)", () => {
  it("stamps the identity and writes the placeholder, but NEVER invalidates", () => {
    // Pins the no-invalidate contract. Platform mechanics (upstream
    // tool-execution.js): ctx.invalidate() synchronously re-runs the
    // row's updateDisplay, which re-invokes renderCall AND renderResult
    // — an invalidate inside render re-enters the pipeline (sync
    // recursion; during a session-restore replay it reset the replay's
    // batch progress and re-printed every frame N times — "bash errors +
    // diffs printed N times, session fills up"). The async render's
    // completion path alone drives the redraw.
    const host = makeHost();
    const text = host.text;
    let invalidations = 0;
    const taskOf = (identity: string, placeholder: string) => ({
      identity,
      placeholder,
      fallback: "F",
      invalidate: (): void => {
        invalidations++;
      },
      key: () => "k",
      render: async () => "R",
    });

    // First attach: placeholder lands synchronously, identity stamped. NO
    // invalidate — the same-build render loop drives the swap instead.
    attachPreviewTask(text, taskOf("id-a", "P-a"));
    expect(text.previewIdentity).toBe("id-a");
    expect(host.current()).toBe("P-a");
    expect(invalidations).toBe(0);

    // Re-run with UNCHANGED inputs: nothing moves — no write, no stamp
    // churn, no invalidate.
    attachPreviewTask(text, taskOf("id-a", "P-a"));
    expect(text.previewIdentity).toBe("id-a");
    expect(host.current()).toBe("P-a");
    expect(invalidations).toBe(0);

    // CHANGED inputs: placeholder re-writes, identity re-stamps — and
    // STILL no invalidate.
    attachPreviewTask(text, taskOf("id-b", "P-b"));
    expect(text.previewIdentity).toBe("id-b");
    expect(host.current()).toBe("P-b");
    expect(invalidations).toBe(0);
  });
});

describe("width-aware render driver (getWidthAwareText)", () => {
  it("drives placeholder → swap → stale-rejection through the real render path", async () => {
    // A fake Text with pi-tui's shape.
    const host = makeHost();
    const text = host.text;
    expect(text.previewWidthAware).toBe(true);

    // Attach a task whose render resolves late with a key check.
    let renders = 0;
    text.previewTask = {
      identity: "fixed",
      placeholder: "loading…",
      fallback: "failed",
      invalidate: () => {},
      key: (w: number) => `k${w}`,
      render: async () => {
        renders++;
        return "rendered-body";
      },
    };

    // First render(width) kicks the async swap: placeholder now, body later.
    const out1 = text.render(80);
    expect(out1).toEqual(["loading…"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.current()).toBe("rendered-body");

    // Same key → no re-render.
    text.render(80);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renders).toBe(1);

    // New key → re-render.
    text.render(100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renders).toBe(2);
  });

  it("falls back to the task fallback when render rejects", async () => {
    const host = makeHost();
    const text = host.text;
    text.previewTask = {
      identity: "fixed",
      placeholder: "loading…",
      fallback: "fallback-body",
      invalidate: () => {},
      key: () => "k",
      render: async () => {
        throw new Error("boom");
      },
    };
    text.render(80);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.current()).toBe("fallback-body");
  });

  it("a changed identity resets the protocol: the next frame re-renders even on a key match", async () => {
    const host = makeHost();
    const text = host.text;
    let renders = 0;
    const taskOf = (identity: string) => ({
      identity,
      placeholder: `P(${identity})`,
      fallback: "F",
      invalidate: () => {},
      key: () => "k",
      render: async () => {
        renders++;
        return `body(${identity})`;
      },
    });
    attachPreviewTask(text, taskOf("id-a"));
    text.render(80);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renders).toBe(1);
    // A re-attach with a NEW identity but an identical key fn: the old
    // rendered key belonged to the old generation — the next frame must
    // re-render (a stale key match would strand the new placeholder).
    attachPreviewTask(text, taskOf("id-b"));
    text.render(80);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renders).toBe(2);
    expect(host.current()).toBe("body(id-b)");
  });

  it("a cleared host re-renders on re-attach even when the key matches", async () => {
    const host = makeHost();
    const text = host.text;
    let renders = 0;
    const task = {
      identity: "fixed",
      placeholder: "loading…",
      fallback: "F",
      invalidate: () => {},
      key: () => "k",
      render: async () => {
        renders++;
        return `body#${renders}`;
      },
    };
    attachPreviewTask(text, task);
    text.render(80);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renders).toBe(1);
    // Clear fully detaches (task, identity, key, queue) then the SAME
    // task re-attaches: without the key reset the frame would see the
    // matching key and never render — a stuck placeholder.
    clearPreviewTask(text);
    text.setText("");
    attachPreviewTask(text, task);
    text.render(80);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renders).toBe(2);
    expect(host.current()).toBe("body#2");
  });

  it("latest-wins: bursts collapse to at most one render behind the in-flight one", async () => {
    const host = makeHost();
    const text = host.text;
    const started: string[] = [];
    let release!: (value: string) => void;
    text.previewTask = {
      identity: "fixed",
      placeholder: "loading…",
      fallback: "failed",
      invalidate: () => {},
      key: (w: number) => `k${w}`,
      render: (w: number) => {
        started.push(`w${w}`);
        if (started.length === 1) return new Promise<string>((resolve) => (release = resolve));
        return Promise.resolve(`body-w${w}`);
      },
    };
    const r1 = text.render(80); // starts w80 (in flight, never resolves yet)
    expect(r1).toEqual(["loading…"]);
    expect(started).toEqual(["w80"]);
    text.render(90); // key advances: pending recorded, no second render
    text.render(100); // key advances again: pending overwritten
    expect(started).toEqual(["w80"]); // still exactly one in flight
    release("stale-body"); // w80 settles — its key is gone: dropped, then w100 runs
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["w80", "w100"]); // the middle key never rendered
    expect(host.current()).toBe("body-w100");
  });

  it("stale rejection: a superseded render neither swaps nor falls back", async () => {
    // The guard's BOTH halves: while task A is mid-flight, a superseding
    // key lands; A's completion (resolve OR reject) must not touch the
    // text. Slow-resolve and slow-reject variants, driven for real.
    // Resolve variant: A resolves late, its key already superseded.
    {
      const host = makeHost();
      let releaseA: ((value: string) => void) | undefined;
      host.text.previewTask = {
        identity: "fixed",
        placeholder: "placeholder",
        fallback: "fallback",
        invalidate: () => {},
        key: () => "a",
        render: () =>
          new Promise<string>((resolve) => {
            releaseA = resolve;
          }),
      };
      host.text.render(80); // starts A, records key "a", lands placeholder
      host.text.previewRenderedKey = "superseded"; // A's key is gone
      releaseA?.("A OUTPUT"); // A resolves — the guard must reject the swap
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host.current()).toBe("placeholder"); // never swapped
    }

    // Reject variant: A rejects late, its key already superseded.
    {
      const host = makeHost();
      let rejectA: ((reason: unknown) => void) | undefined;
      host.text.previewTask = {
        identity: "fixed",
        placeholder: "placeholder",
        fallback: "fallback",
        invalidate: () => {},
        key: () => "a",
        render: () =>
          new Promise<string>((_resolve, reject) => {
            rejectA = reject;
          }),
      };
      host.text.render(80);
      host.text.previewRenderedKey = "superseded";
      rejectA?.(new Error("late boom")); // the guard must reject the fallback too
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host.current()).toBe("placeholder"); // no fallback landed
    }
  });
});
