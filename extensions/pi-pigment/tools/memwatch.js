// memwatch.js — attach to a Node inspector (see README.md in this dir) and
// stream one line per sample of process.memoryUsage(). Sized for trend
// watching: run it while poking the TUI (scroll / collapse / expand /
// restore) to see which interactions allocate and whether GC reclaims.
//
//   node tools/memwatch.js [port=9229] [intervalMs=2000]
//
// Output columns: t<s> heap=<heapUsed MB>/<heapTotal MB>.

const port = process.argv[2] ?? "9229";
const intervalMs = Number(process.argv[3] ?? "2000");

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

const MEM = `(() => { const m = process.memoryUsage(); return JSON.stringify({ heapUsed: Math.round(m.heapUsed / 1048576), heapTotal: Math.round(m.heapTotal / 1048576) }); })()`;
let t = 0;
while (true) {
  const r = await call("Runtime.evaluate", { expression: MEM, returnByValue: true });
  const v = r.result?.result?.value;
  console.log(`t${t}s heap=${v}`);
  t += intervalMs / 1000;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
