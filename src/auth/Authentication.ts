// Challenge / Reply authentication (MANUAL pp.40–42, SPEC_DELTA §5.4).
//
// The real KL-43 response algorithm is classified; this is a faithfulness-
// preserving substitute that reproduces the manual's observable behaviour:
//
//   - Challenge alphabet: 4 letters A–Z (MANUAL p.41). 20 bits entropy.
//   - Reply alphabet: 4 characters A–Z + 2–7 (base32) (MANUAL p.42). 20 bits.
//   - Sending and receiving clocks must agree within 20 minutes (MANUAL
//     p.40). We quantize UTC into 10-minute buckets and allow ±2 buckets of
//     slack, giving a ±20 minute acceptance window.
//   - Any currently-selected key can authenticate; there is no separate
//     "auth key slot" in the real device (MANUAL p.41 — "the same key" as
//     encryption). Callers pass the key material directly.
//
// Substitute algorithm (marked SUBSTITUTE in SPEC_DELTA §5.4):
//
//   reply_bits = first 20 bits of HMAC-SHA-256(current_key,
//                  ascii(challenge) || be64(bucket_10min))
//   reply      = base32Encode20(reply_bits)   // 4 base32 chars
//
// The 10-minute bucket and ±2-bucket window are our choices constrained
// only by the 20-minute sync figure from the manual. Any change to bucket
// width must update both sides simultaneously — callers pass the same
// `nowUtcMs` on both sides of a challenge/reply exchange.

import { hmacSha256 } from "../crypto/primitives.js";

export const CHALLENGE_LENGTH = 4;       // 4 letters A-Z (20 bits)
export const REPLY_LENGTH = 4;           // 4 chars A-Z + 2-7 (20 bits)
export const BUCKET_MINUTES = 10;
export const BUCKET_MS = BUCKET_MINUTES * 60 * 1000;
/** Accept ±2 buckets → ±20 minutes, matching MANUAL p.40. */
export const BUCKET_WINDOW = 2;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class InvalidChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChallengeError";
  }
}

export class InvalidReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReplyError";
  }
}

/**
 * Generate a fresh challenge. The random source must return `CHALLENGE_LENGTH`
 * bytes; each byte is reduced mod 26 to form an A–Z letter. Same pattern as
 * MI generation (see src/crypto/Mi.ts).
 */
export function generateChallenge(randomSource: (n: number) => Uint8Array): string {
  const raw = randomSource(CHALLENGE_LENGTH);
  if (raw.length !== CHALLENGE_LENGTH) {
    throw new RangeError(
      `random source returned ${raw.length} bytes, expected ${CHALLENGE_LENGTH}`,
    );
  }
  const A = "A".charCodeAt(0);
  let out = "";
  for (const b of raw) out += String.fromCharCode(A + (b % 26));
  return out;
}

/** Quantize a UTC time (ms since epoch) into the 10-minute bucket used by HMAC. */
export function bucketForTime(utcMs: number): number {
  if (!Number.isFinite(utcMs)) throw new RangeError(`utcMs must be finite, got ${utcMs}`);
  return Math.floor(utcMs / BUCKET_MS);
}

/**
 * Compute the 4-character base32 reply for (key, challenge, time). Callers
 * on both the challenger and replier sides compute this identically; the
 * reply is compared character-wise.
 */
export function computeReply(key: Uint8Array, challenge: string, utcMs: number): string {
  validateChallenge(challenge);
  const bucket = bucketForTime(utcMs);
  return computeReplyForBucket(key, challenge, bucket);
}

/**
 * Verify a reply against (key, challenge, now). Tries the current bucket
 * first, then ±1, ±2. Returns the bucket offset that matched (0 = exact,
 * ±1 = one bucket off, ±2 = two buckets off) or null if none match.
 */
export function verifyReply(
  key: Uint8Array,
  challenge: string,
  reply: string,
  utcMs: number,
): { offset: number } | null {
  validateChallenge(challenge);
  const expected = reply.toUpperCase();
  validateReply(expected);
  const centerBucket = bucketForTime(utcMs);
  // Try offset 0 first so the common case exits fastest.
  const tryOrder = [0, -1, 1, -2, 2];
  for (const offset of tryOrder) {
    if (Math.abs(offset) > BUCKET_WINDOW) continue;
    const candidate = computeReplyForBucket(key, challenge, centerBucket + offset);
    if (constantTimeEquals(candidate, expected)) return { offset };
  }
  return null;
}

function computeReplyForBucket(key: Uint8Array, challenge: string, bucket: number): string {
  const challengeBytes = new TextEncoder().encode(challenge);
  const bucketBytes = encodeBucketBE(bucket);
  const material = new Uint8Array(challengeBytes.length + bucketBytes.length);
  material.set(challengeBytes, 0);
  material.set(bucketBytes, challengeBytes.length);
  const mac = hmacSha256(key, material);
  return encode20Bits(mac);
}

/**
 * Encode the 10-minute bucket number as 8 big-endian bytes. We use `BigInt`
 * to cover buckets past 2^31 without signed-shift surprises (Year ~2387
 * even at 10-minute resolution is still within safe integer range, but the
 * big-endian encoding is the part that needs to survive).
 */
function encodeBucketBE(bucket: number): Uint8Array {
  const out = new Uint8Array(8);
  let b = BigInt(bucket);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(b & 0xffn);
    b >>= 8n;
  }
  return out;
}

/** Take the first 20 bits of `mac` MSB-first and emit 4 base32 chars. */
function encode20Bits(mac: Uint8Array): string {
  if (mac.length < 3) {
    throw new RangeError(`HMAC output must be ≥3 bytes, got ${mac.length}`);
  }
  // 20 bits = byte0 (8) + byte1 (8) + high nibble of byte2 (4).
  const high20 =
    (mac[0]! << 12) | (mac[1]! << 4) | ((mac[2]! >>> 4) & 0x0f);
  let out = "";
  for (let i = 0; i < 4; i++) {
    const shift = 15 - i * 5; // 15, 10, 5, 0
    const v = (high20 >>> shift) & 0x1f;
    out += BASE32_ALPHABET[v];
  }
  return out;
}

function validateChallenge(challenge: string): void {
  if (challenge.length !== CHALLENGE_LENGTH) {
    throw new InvalidChallengeError(
      `challenge must be ${CHALLENGE_LENGTH} letters, got ${challenge.length}`,
    );
  }
  if (!/^[A-Z]+$/.test(challenge)) {
    throw new InvalidChallengeError(
      `challenge must be A-Z, got ${JSON.stringify(challenge)}`,
    );
  }
}

function validateReply(reply: string): void {
  if (reply.length !== REPLY_LENGTH) {
    throw new InvalidReplyError(
      `reply must be ${REPLY_LENGTH} chars, got ${reply.length}`,
    );
  }
  if (!/^[A-Z2-7]+$/.test(reply)) {
    throw new InvalidReplyError(
      `reply must be A-Z + 2-7, got ${JSON.stringify(reply)}`,
    );
  }
}

/** Length-aware, early-exit-resistant equality for short fixed-length strings. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
