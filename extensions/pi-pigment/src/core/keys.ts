/**
 * The key machinery: `fnv1a` fingerprints one string, `joinKey` joins
 * many into a cache/identity key. Every key in the codebase routes
 * through these two — no call site hand-rolls a separator or a hash.
 */

import { KEY_SEP } from "./escapes.ts";

/**
 * FNV-1a (32-bit) — the string fingerprint behind cache/identity keys
 * (the grep swap key, the seed's highlight-cache key, the theme
 * registration-name hash). One pass, no allocation, ample for keying.
 *
 * @param s - The text to fingerprint.
 * @returns The 8-hex-digit FNV-1a digest.
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Join a key's segments with the NUL separator.
 *
 * NUL rather than ":": Unix paths may contain colons and Windows drive
 * letters always do, and no segment we pass can contain NUL itself —
 * inert text maps C0 controls (NUL included) to caret notation before any
 * user data reaches a key. That invariant is what keeps the join total:
 * whatever a segment contains, `joinKey` cannot fabricate a collision.
 *
 * @param segments - The key's segments (callers pre-string optionals).
 * @returns The joined key.
 */
export function joinKey(segments: readonly (string | number)[]): string {
  return segments.join(KEY_SEP);
}
