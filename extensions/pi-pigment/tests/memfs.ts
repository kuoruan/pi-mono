/**
 * The shared memfs plumbing for suites that mock node:fs (the
 * __mocks__/fs.cjs pattern): one write helper over the volume. Suites
 * that EXECUTE the SDK's own file scanners (grep/find/ls/edit on real
 * paths) must NOT mock node:fs — those scanners bypass it; see
 * inert-output.test.ts's note.
 */
import { vol } from "memfs";

/** The volume every suite's vi.mock("node:fs") binds to. */
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
