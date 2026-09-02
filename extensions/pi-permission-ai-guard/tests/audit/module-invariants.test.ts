/**
 * Audit-module invariants, mechanically enforced by source scan (the
 * tests' whole point is to TRIP on a future edit — see the module
 * docblocks for the doctrines they pin):
 *
 * - Report.ts + decision-log-reader.ts import no `node:fs` — the reader's file access is injected
 *   through the `ReadTailLines` seam (the production adapter is log-tail-fs.ts); the format owner
 *   stays pure.
 * - None of the three references a write-family call — the report command produces evidence, never an
 *   applied rule; the reader and the tail adapter read, never write.
 *
 * The `#src` alias resolves each scanned file (no ../ chains — a moved
 * file keeps this test compiling against its new path).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Read a src module's text through the #src alias.
 *
 * @param specifier - The module specifier (e.g. `#src/audit/report.ts`).
 * @returns The module's source text.
 */
function srcText(specifier: string): string {
  return readFileSync(fileURLToPath(import.meta.resolve(specifier)), "utf8");
}

/** The write-family tripwires (substring scan of the module body). */
const BANNED_WRITE_CALLS = [
  "writeFile",
  "appendFile",
  "writeSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "truncate",
  "renameSync",
  "createWriteStream",
  "copyFile",
  'openSync(path, "w")',
] as const;

describe("audit module invariants (source scan)", () => {
  it("report.ts and decision-log-reader.ts import no node:fs (file access is injected)", () => {
    for (const name of ["#src/audit/report.ts", "#src/audit/decision-log-reader.ts"]) {
      const src = srcText(name);
      expect(src.includes('from "node:fs"'), `${name} must not import node:fs`).toBe(false);
    }
  });

  it("the audit modules reference no write-family call (never writes, never auto-applies)", () => {
    for (const name of [
      "#src/audit/report.ts",
      "#src/audit/decision-log-reader.ts",
      "#src/audit/log-tail-fs.ts",
      // The tail adapter is the one permitted fs reader — read-only by
      // the same invariant.
    ]) {
      const src = srcText(name);
      for (const banned of BANNED_WRITE_CALLS) {
        expect(src.includes(banned), `${name} must not reference ${banned}`).toBe(false);
      }
    }
  });
});
