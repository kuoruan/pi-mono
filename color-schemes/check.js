#!/usr/bin/env node
// WCAG contrast checker for terminal color schemes.
//
// A format-independent WCAG core plus an adapter registry (ADAPTERS), one
// adapter per terminal. windows-terminal is built in; adding a terminal means
// registering a detect() and a slot spec, with no core changes. Adapter ids
// match color-schemes/<terminal>/ directory names, so files match by path
// first and by JSON shape second.
//
// Usage: node color-schemes/check.js [--target aa|aaa] [--exempt s1,s2] [--dim s1,s2] <scheme.json>
// Exit codes: 0 all non-exempt slots pass; 1 failed, invalid, or missing
// slots (dim slots fail below 3:1); 2 usage error, unreadable file, or
// unknown format.

import { readFileSync } from "node:fs";

const TARGETS = { aa: { name: "AA (>= 4.5:1)", min: 4.5 }, aaa: { name: "AAA (>= 7:1)", min: 7 } };

// WCAG core (format-independent).
const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const normalizeHex = (hex) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const digits = m[1];
  return digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits;
};
const lum = (hex6) => {
  const n = parseInt(hex6, 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// Format adapters. id matches the color-schemes/<terminal>/ directory name;
// detect(json) is the shape check used when no path hint matches; canvas(json)
// is the contrast anchor; primary(json) lists [label, hex] checked against it;
// selection(json) is an optional informational self-contrast; slots(json) lists
// [label, hex, kind] where kind "exempt" is reported but never fails
// (physically impossible pairs, e.g. brightWhite on a light surface).
// Per-scheme CLI tiers: --exempt marks structural slots that act as surfaces
// (panel black on dark themes); --dim grades at the 3:1 floor of the dim tier.
const ANSI_16 = [
  ["black", "base"],
  ["red", "base"],
  ["green", "base"],
  ["yellow", "base"],
  ["blue", "base"],
  ["purple", "base"],
  ["cyan", "base"],
  ["white", "base"],
  ["brightBlack", "bright"],
  ["brightRed", "bright"],
  ["brightGreen", "bright"],
  ["brightYellow", "bright"],
  ["brightBlue", "bright"],
  ["brightPurple", "bright"],
  ["brightCyan", "bright"],
  ["brightWhite", "exempt"],
];
const ADAPTERS = [
  {
    id: "windows-terminal",
    detect: (j) =>
      j &&
      typeof j.background === "string" &&
      typeof j.foreground === "string" &&
      typeof j.black === "string" &&
      typeof j.brightWhite === "string",
    canvas: (j) => j.background,
    primary: (j) => [
      ["foreground", j.foreground],
      ["cursor", j.cursorColor],
    ],
    selection: (j) =>
      j.selectionBackground
        ? { bg: j.selectionBackground, fg: j.foreground ?? j.cursorColor }
        : null,
    slots: (j) => ANSI_16.map(([slot, kind]) => [slot, j[slot], kind]),
  },
  // Future: kitty (color0..color15), iterm2 (plist), base24 (base00..base17).
  // Non-JSON formats will add a file-reading and parsing hook on their adapter.
];

function pickAdapter(json, file) {
  const hinted = ADAPTERS.find((a) => file.replaceAll("\\", "/").includes(`/${a.id}/`));
  if (hinted && hinted.detect(json)) return hinted;
  return ADAPTERS.find((a) => a.detect(json));
}

// Main flow.
function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    "Usage: node color-schemes/check.js [--target aa|aaa] [--exempt s1,s2] [--dim s1,s2] <scheme.json>",
  );
  process.exit(2);
}
function parseArgs(argv) {
  let target = "aa";
  let file = null;
  const exempt = new Set();
  const dim = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" || arg.startsWith("--target=")) {
      const value = arg.includes("=") ? arg.split("=")[1] : argv[++i];
      if (!TARGETS[value]) usage(`Unknown target: ${value ?? "(none)"}`);
      target = value;
    } else if (
      arg === "--exempt" ||
      arg.startsWith("--exempt=") ||
      arg === "--dim" ||
      arg.startsWith("--dim=")
    ) {
      const flag = arg.startsWith("--exempt") ? "--exempt" : "--dim";
      const value = arg.includes("=") ? arg.split("=")[1] : argv[++i];
      if (!value) usage(`Missing value for ${flag}`);
      for (const slot of value.split(",")) (flag === "--exempt" ? exempt : dim).add(slot.trim());
    } else if (arg.startsWith("-")) {
      usage(`Unknown flag: ${arg}`);
    } else if (file === null) {
      file = arg;
    } else {
      usage(`Unexpected extra argument: ${arg}`);
    }
  }
  if (file === null) usage();
  return { target, file, exempt, dim };
}

const { target, file, exempt, dim } = parseArgs(process.argv.slice(2));
const { name, min } = TARGETS[target];
const DIM_MIN = 3;

let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  if (err.code === "ENOENT") usage(`No such file: ${file}`);
  usage(`Cannot parse ${file} as JSON (adapters currently accept JSON only).`);
}
const adapter = pickAdapter(raw, file);
if (!adapter) {
  console.error(
    `Cannot identify the format of ${file}. Built-in adapters: ${ADAPTERS.map((a) => a.id).join(", ")}`,
  );
  process.exit(2);
}
const bgShown = adapter.canvas(raw);
const bg = typeof bgShown === "string" ? normalizeHex(bgShown) : null;
if (!bg) usage(`${adapter.id}: missing or invalid canvas background`);

let failures = 0;
const rows = [];
const check = (label, hex, adapterKind) => {
  const kind = exempt.has(label) ? "exempt" : dim.has(label) ? "dim" : adapterKind;
  const norm = typeof hex === "string" ? normalizeHex(hex) : null;
  if (!norm) {
    rows.push({
      label,
      hex: typeof hex === "string" ? hex : "(missing)",
      ratio: null,
      kind,
      verdict: typeof hex === "string" ? "INVALID" : "MISSING",
    });
    failures++;
    return;
  }
  const r = ratio(norm, bg);
  const pass = kind === "exempt" ? true : r >= (kind === "dim" ? DIM_MIN : min);
  const verdict = kind === "exempt" && !(r >= min) ? "EXEMPT" : pass ? "PASS" : "FAIL";
  if (!pass) failures++;
  rows.push({ label, hex, ratio: r, kind, verdict });
};

console.log(`${file}  [${adapter.id}]  vs background ${bgShown}  target: ${name}`);
console.log("-".repeat(64));
for (const [label, hex] of adapter.primary(raw)) check(label, hex, "base");
for (const [label, hex, kind] of adapter.slots(raw)) check(label, hex, kind);

const pad = Math.max(...rows.map((r) => r.label.length), 8);
for (const row of rows) {
  const ratioStr = row.ratio === null ? " n/a" : row.ratio.toFixed(2).padStart(5);
  console.log(
    `${row.label.padEnd(pad)}  ${row.hex ?? ""}  ${ratioStr}  ${row.verdict.padEnd(7)} [${row.kind}]`,
  );
}
const sel = adapter.selection(raw);
if (sel) {
  const pair = [sel.bg, sel.fg].map((h) => (typeof h === "string" ? normalizeHex(h) : null));
  if (pair[0] && pair[1])
    console.log(`selection: ${sel.fg} vs ${sel.bg} = ${ratio(pair[0], pair[1]).toFixed(2)}:1`);
  else console.log("selection: missing or invalid colors, skipped");
}
console.log("-".repeat(64));
if (failures === 0) {
  console.log(`OK: all non-exempt slots satisfy ${name}`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failures} slot(s) below target or missing`);
  process.exit(1);
}
