/**
 * The shared memfs plumbing for suites that mock node:fs (via
 * `vi.mock("node:fs")` + `__mocks__/fs.cjs`): one write helper over the
 * volume, so file-I/O tests never touch the machine's real filesystem
 * (agent dir, tmp dirs) — the outcome must not depend on which files
 * exist under `$HOME`.
 *
 * Suites that scan the REPO's own source files (notify-skeleton,
 * config-surface-drift, module-invariants) do NOT mock node:fs: they read
 * the checkout as their fixture, which is identical on every machine.
 */
import { vol } from "memfs";

/** The volume every suite's `vi.mock("node:fs")` binds to. */
export { vol };

/**
 * Write a file (creating parent directories) into the volume.
 *
 * @param path - The virtual path.
 * @param content - The file content (objects JSON-stringify).
 */
export function writeFile(path: string, content: string | object): void {
  vol.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  vol.writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}
