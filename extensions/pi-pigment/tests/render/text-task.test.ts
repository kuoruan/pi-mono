/**
 * The width-aware render driver: getWidthAwareText's placeholder → swap →
 * stale-rejection protocol, driven through a fake Text with pi-tui's shape.
 */

import { describe, expect, it } from "vitest";

import {
  attachPreviewTask,
  clearPreviewTask,
  definePreviewTask,
  getWidthAwareText,
} from "#src/render/text-task.ts";
import { taskKeyOf } from "#src/render/tool-output.ts";

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

describe("definePreviewTask (the task builder)", () => {
  it("derives the identity from prefix+stamps through taskKeyOf — ONE stamp list, both compares", () => {
    // The construction contract: the call site's visible stamp array is
    // the single source; the identity (attach guard) and the render key
    // (cache) both derive from it — they can no longer drift apart.
    const task = definePreviewTask({
      prefix: "wd",
      stamps: ["pal-id", 12, "ts", ""],
      widthAware: true,
      placeholder: "P",
      fallback: "F",
      invalidate: () => {},
      render: async () => "R",
    });
    expect(task.identity).toBe(taskKeyOf("wd", ["pal-id", 12, "ts", ""]));
  });

  it("widthAware: the key is the width-appended identity (a resize re-keys)", () => {
    const task = definePreviewTask({
      prefix: "nf",
      stamps: ["file.ts", "pal-id"],
      widthAware: true,
      placeholder: "P",
      fallback: "F",
      invalidate: () => {},
      render: async () => "R",
    });
    expect(task.key(80)).toBe(`${task.identity}\u000080`);
    expect(task.key(100)).not.toBe(task.key(80));
  });

  it("widthAware: false — the key ignores width (a resize reuses the render)", () => {
    const task = definePreviewTask({
      identity: "g\u0000content-hash",
      widthAware: false,
      placeholder: "P",
      fallback: "F",
      invalidate: () => {},
      render: async () => "R",
    });
    expect(task.key(80)).toBe("g\u0000content-hash");
    expect(task.key(100)).toBe(task.key(80));
  });

  it("drives the render loop: width-aware re-renders on resize, width-neutral does not", async () => {
    // The widthAware decision, exercised through the real frame loop:
    // a width-sensitive preview re-renders when the width changes; a
    // width-neutral one keeps its frame.
    const drive = async (widthAware: boolean): Promise<number> => {
      const host = makeHost();
      let renders = 0;
      attachPreviewTask(
        host.text,
        definePreviewTask({
          prefix: "t",
          stamps: ["frozen"],
          widthAware,
          placeholder: "loading…",
          fallback: "F",
          invalidate: () => {},
          render: async () => {
            renders += 1;
            return "body";
          },
        }),
      );
      host.text.render(80);
      await new Promise((resolve) => setTimeout(resolve, 20));
      host.text.render(120); // the resize event
      await new Promise((resolve) => setTimeout(resolve, 20));
      return renders;
    };
    expect(await drive(true)).toBe(2); // resize → fresh key → re-render
    expect(await drive(false)).toBe(1); // same key → the frame stands
  });
});

describe("width-aware render driver (getWidthAwareText)", () => {
  it("drives placeholder → swap → stale-rejection through the real render path", async () => {
    // A fake Text with pi-tui's shape.
    const host = makeHost();
    const text = host.text;
    expect(text.previewWidthAware).toBe(true);

    // Attach a task whose render resolves late with a key check (the
    // attach guard prints the placeholder; render() never re-prints it).
    let renders = 0;
    attachPreviewTask(text, {
      identity: "fixed",
      placeholder: "loading…",
      fallback: "failed",
      invalidate: () => {},
      key: (w: number) => `k${w}`,
      render: async () => {
        renders++;
        return "rendered-body";
      },
    });

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
    attachPreviewTask(text, {
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
    });
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
      attachPreviewTask(host.text, {
        identity: "fixed",
        placeholder: "placeholder",
        fallback: "fallback",
        invalidate: () => {},
        key: () => "a",
        render: () =>
          new Promise<string>((resolve) => {
            releaseA = resolve;
          }),
      });
      host.text.render(80); // starts A, records key "a"
      host.text.previewRenderedKey = "superseded"; // A's key is gone
      releaseA?.("A OUTPUT"); // A resolves — the guard must reject the swap
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host.current()).toBe("placeholder"); // never swapped
    }

    // Reject variant: A rejects late, its key already superseded.
    {
      const host = makeHost();
      let rejectA: ((reason: unknown) => void) | undefined;
      attachPreviewTask(host.text, {
        identity: "fixed",
        placeholder: "placeholder",
        fallback: "fallback",
        invalidate: () => {},
        key: () => "a",
        render: () =>
          new Promise<string>((_resolve, reject) => {
            rejectA = reject;
          }),
      });
      host.text.render(80);
      host.text.previewRenderedKey = "superseded";
      rejectA?.(new Error("late boom")); // the guard must reject the fallback too
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host.current()).toBe("placeholder"); // no fallback landed
    }
  });
});
