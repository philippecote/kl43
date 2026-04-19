// Message Indicator (MI) — the 12-character preamble sent in cleartext
// with every ciphertext message. The MI carries IV entropy and a checksum
// that lets the receiver fail fast on typos before attempting decryption.
//
// Real KL-43 indicator format is unknown. Substitute (spec §6.4):
//
//   MI = random 10-letter group (A–Z) || 2-letter checksum
//
// - 10-letter random body: 50 bits of CSPRNG entropy encoded A–Z.
// - 2-letter checksum: deterministic function of the body; lets the receiver
//   reject MIs with typos before trying to decrypt (cheap integrity check).
// - IV for CBC: SHA-256(MI_bytes || sessionKey)[:ivBytes].
//
// The MI is transmitted aloud over voice radio and so stays in the A-Z
// phonetic-friendly alphabet; the ciphertext body that follows uses the
// larger base32 alphabet (see SPEC_DELTA §6.7).

import { sha256 } from "./primitives.js";

export const MI_BODY_LENGTH = 10;
export const MI_CHECKSUM_LENGTH = 2;
export const MI_TOTAL_LENGTH = MI_BODY_LENGTH + MI_CHECKSUM_LENGTH;

export class InvalidMiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMiError";
  }
}

/**
 * Generate a fresh MI. The body is drawn from `randomSource` which must
 * return `MI_BODY_LENGTH` bytes (we take each byte mod 26). Callers pass
 * `randomBytes` in production and a seeded function in tests.
 */
export function makeMi(randomSource: (n: number) => Uint8Array): string {
  const raw = randomSource(MI_BODY_LENGTH);
  if (raw.length !== MI_BODY_LENGTH) {
    throw new RangeError(
      `random source returned ${raw.length} bytes, expected ${MI_BODY_LENGTH}`,
    );
  }
  let body = "";
  const A = "A".charCodeAt(0);
  for (const b of raw) body += String.fromCharCode(A + (b % 26));
  return body + miChecksum(body);
}

/**
 * Parse and validate a 12-char MI string. Returns the body and checksum;
 * throws on bad shape, bad alphabet, or checksum mismatch.
 */
export function parseMi(mi: string): { body: string; checksum: string } {
  if (mi.length !== MI_TOTAL_LENGTH) {
    throw new InvalidMiError(`MI must be ${MI_TOTAL_LENGTH} letters, got ${mi.length}`);
  }
  if (!/^[A-Z]+$/.test(mi)) {
    throw new InvalidMiError(`MI must be uppercase A-Z, got ${JSON.stringify(mi)}`);
  }
  const body = mi.slice(0, MI_BODY_LENGTH);
  const checksum = mi.slice(MI_BODY_LENGTH);
  const expected = miChecksum(body);
  if (checksum !== expected) {
    throw new InvalidMiError("BAD HEADER — CHECK KEY/UPDATE");
  }
  return { body, checksum };
}

/**
 * Derive a CBC IV for this message: SHA-256(MI_bytes || sessionKey)[:ivBytes].
 * Both sender and receiver compute this identically once they agree on the
 * session key and have parsed the MI.
 */
export function deriveIv(mi: string, sessionKey: Uint8Array, ivBytes: number): Uint8Array {
  if (ivBytes <= 0 || ivBytes > 32) {
    throw new RangeError(`ivBytes must be in (0, 32], got ${ivBytes}`);
  }
  // parseMi validates shape before we hash; callers that already parsed can
  // pass through confident, but we double-check here to prevent hashing
  // garbage into a persistent IV.
  parseMi(mi);
  const miBytes = new TextEncoder().encode(mi);
  const material = new Uint8Array(miBytes.length + sessionKey.length);
  material.set(miBytes, 0);
  material.set(sessionKey, miBytes.length);
  return sha256(material).slice(0, ivBytes);
}

/**
 * 2-letter checksum of a 10-letter MI body.
 *
 * Definition: take bytes 0 and 1 of SHA-256(body_bytes), reduce each mod 26,
 * encode as A-Z. This is deterministic, easy to recompute by hand-adjacent
 * tooling, and preserves ~9.4 bits of integrity — enough to catch single-
 * letter transcription errors with high probability while staying inside
 * the 2-letter budget.
 */
export function miChecksum(body: string): string {
  if (body.length !== MI_BODY_LENGTH) {
    throw new RangeError(`MI body must be ${MI_BODY_LENGTH} letters, got ${body.length}`);
  }
  if (!/^[A-Z]+$/.test(body)) {
    throw new InvalidMiError(`MI body must be A-Z, got ${JSON.stringify(body)}`);
  }
  const digest = sha256(new TextEncoder().encode(body));
  const A = "A".charCodeAt(0);
  return (
    String.fromCharCode(A + (digest[0]! % 26)) +
    String.fromCharCode(A + (digest[1]! % 26))
  );
}
