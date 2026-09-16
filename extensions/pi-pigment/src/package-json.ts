/**
 * Package.json, read once — the single reader for the package version, so the
 * public `VERSION` export (root entry `render-kit.ts`) and the
 * publication payload's `packageVersion` field (kit.ts) can never disagree.
 *
 * Read at load, never a literal, so it cannot drift from the release.
 */

import packageJson from "#root/package.json" with { type: "json" };

/** The pi-pigment release version (mirrors package.json). */
export const VERSION: string = packageJson.version;
