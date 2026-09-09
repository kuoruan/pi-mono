# Memory tools

Debugging memory in pi-pigment (or any Node process) without browser tooling.
pi runs inside pi-tui's Node process — Chrome DevTools' Node inspector speaks
the same protocol the browser tools use, so these scripts attach straight to
the running pi process.

## Open the inspector on a running pi

1. Find the pi process (the _child_, not the tmux wrapper):

   ```sh
   ps -ef --forest | grep -A2 tmux        # the pi child sits under tmux
   readlink /proc/<pid>/exe               # must be .../bin/node
   ```

2. Open the inspector — `SIGUSR1` works on any Node process, no `--inspect`
   at startup needed:

   ```sh
   kill -USR1 <pid>
   curl -s http://127.0.0.1:9229/json/list   # confirm the target appears
   ```

   The port is 9229 (9229+ for additional processes). Exit the inspector by
   killing `ptyhost`/the pty or restarting pi — the port is released when
   the process dies.

## Tools

```sh
node tools/memwatch.js [port=9229] [intervalMs=2000]
node tools/memprof.js [port=9229] [seconds=60] [out=/tmp/heap-profile.json]
node tools/theme-switch-bench.js [blocks=30] [lines=60]
```

- **memwatch** — a line per sample of `process.memoryUsage()`
  (`heapUsed`/`heapTotal` in MB). Run it while poking the TUI — scroll,
  collapse/expand frames, restore sessions — to see which interactions
  allocate, then watch whether GC reclaims between actions.
- **memprof** — two phases: first it force-GCs (`HeapProfiler.collectGarbage`)
  and prints pre/post `heapUsed` — **a slope that survives the GC is real
  retention**; a slope that collects is just garbage pending collection.
  Then it runs a _sampling_ heap profiler (compact call-site allocation
  tree, not a full snapshot) and dumps the JSON. Sort
  `profile.head.samples` by `selfSize` descending to name the allocating
  functions. Note: attribution ≠ retention — for retainer chains use the
  DevTools Memory panel (below).
- **theme-switch-bench** — the theme-switch re-highlight cost: N code blocks
  rendered warm under theme A, then cold under theme B (parallel and
  sequential shapes), plus a tokenize-only split so the tokenizer's share
  is visible. The regression harness for theme-switch cost — run it after
  any highlight/theme-selection change.

## Deep dives (manual)

- **Retainer chains / dominators** (what _holds_ live objects): open
  `chrome://inspect` → the Node target is listed → Memory tab → take two
  heap snapshots before/after the suspected workload → Compare. Same flow
  as the browser memory workflow.
- **Class-level diffs**: `compare_heapsnapshots`-style analysis is manual
  in DevTools; the sampling profile above usually names the allocation
  site first.

## What the numbers mean for pi-pigment

- The extension's one-time cost over native pi on the same session ≈
  shiki grammars + per-frame render state (measured ~45MB on a 45MB
  conversation). That is proportional to session size, not a leak.
- The restore phase allocates progressively (deferred frame rendering)
  and then stops — expect a climb that plateaus, not a flat line.
- A slope that survives the GC-trap _and_ keeps rising without
  interaction is the only thing that needs chasing.
