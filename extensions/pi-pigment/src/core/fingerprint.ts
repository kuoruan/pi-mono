/**
 * FNV-1a (32-bit) — the string fingerprint behind cache/identity keys
 * (the grep swap key, the seed's highlight-cache key, the theme
 * registration-name hash). One pass, no allocation, ample for keying.
 */

/**
 * Fingerprint a string as a hex string.
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
