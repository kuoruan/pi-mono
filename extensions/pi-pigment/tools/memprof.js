// memprof.js — the attribution tool. Attach to a Node inspector (see
// README.md in this dir), then:
//
//   1. verdict: force GC once and compare heapUsed — a slope that survives
//      the GC is real retention (worth chasing); a slope that collects is
//      just garbage pending collection.
//   2. attribution: run a *sampling* heap profiler for N seconds and dump
//      the call-site allocation tree — a compact JSON (samples, not full
//      nodes) whose top self-sizes name the allocating functions.
//
//   node tools/memprof.js [port=9229] [seconds=60] [out=/tmp/heap-profile.json]
//
// Read the profile by sorting head.samples by selfSize descending — each
// sample's call frame chain points at the allocation site. For retainer
// chains (who holds live objects, not who allocated), use the DevTools
// Memory panel instead: chrome://inspect -> attach to the same target ->
// take two snapshots and compare.

import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9229";
const seconds = Number(process.argv[3] ?? "60");
const out = process.argv[4] ?? "/tmp/heap-profile.json";

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const target = list.find((t) => t.webSocketDebuggerUrl) ?? list[0];
if (!target) {
  console.error(`no inspector target on port ${port}`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const call = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await new Promise((resolve) => ws.addEventListener("open", resolve));
await call("Runtime.enable");
await call("HeapProfiler.enable");

const HEAP = `(() => { const m = process.memoryUsage(); return JSON.stringify({ heapUsed: Math.round(m.heapUsed / 1048576), heapTotal: Math.round(m.heapTotal / 1048576) }); })()`;
const mem = async (tag) => {
  const r = await call("Runtime.evaluate", { expression: HEAP, returnByValue: true });
  console.log(`${tag}: ${r.result?.result?.value}`);
};

await mem("pre-GC      ");
await call("HeapProfiler.collectGarbage");
await mem("post-GC     ");

console.log(`sampling heap profiler for ${seconds}s...`);
await call("HeapProfiler.startSampling", { samplingInterval: 16384 });
const start = Date.now();
while (Date.now() - start < seconds * 1000) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
const prof = await call("HeapProfiler.stopSampling");
await mem("post-profile");

const head = prof.result?.profile;
writeFileSync(out, JSON.stringify(head, null, 0));
console.log(`profile -> ${out} (${head?.samples?.length ?? "0"} samples)`);
ws.close();
process.exit(0);
