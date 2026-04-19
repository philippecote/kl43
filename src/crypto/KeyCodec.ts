// A-Z to 4-bit nibble mapping per KL-43C spec §6.2.
// A=0..P=15 directly; Q-Z alias to A-J (Q≡A, R≡B, ..., Z≡J).
// Every input letter therefore has a valid nibble, but only A-P are
// canonical outputs — nibbleToLetter never returns Q-Z.
//
// A 32-letter key encodes 128 bits = 16 bytes:
//   - Bytes 0..14: k_raw (120 bits of key material)
//   - Byte 15:     8-bit checksum = sum(k_raw) mod 256
// Checksum mismatch on LOAD → "Key is Invalid".

export const KEY_LENGTH = 32;
export const K_RAW_LENGTH = 15;
export const KEY_BYTES_LENGTH = 16;

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyError";
  }
}

export function letterToNibble(ch: string): number {
  if (ch.length !== 1) {
    throw new InvalidKeyError(`expected single character, got ${ch.length}`);
  }
  const code = ch.charCodeAt(0);
  const A = "A".charCodeAt(0);
  const P = "P".charCodeAt(0);
  const Q = "Q".charCodeAt(0);
  const Z = "Z".charCodeAt(0);
  if (code >= A && code <= P) return code - A;
  if (code >= Q && code <= Z) return code - Q;
  throw new InvalidKeyError(`not A-Z: ${JSON.stringify(ch)}`);
}

export function nibbleToLetter(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 15) {
    throw new RangeError(`nibble out of range: ${n}`);
  }
  return String.fromCharCode("A".charCodeAt(0) + n);
}

export function computeChecksum(kRaw: Uint8Array): number {
  if (kRaw.length !== K_RAW_LENGTH) {
    throw new RangeError(`k_raw must be ${K_RAW_LENGTH} bytes, got ${kRaw.length}`);
  }
  let sum = 0;
  for (const b of kRaw) sum = (sum + b) & 0xff;
  return sum;
}

export function encodeKey(letters: string): Uint8Array {
  if (letters.length !== KEY_LENGTH) {
    throw new InvalidKeyError(`expected ${KEY_LENGTH} letters, got ${letters.length}`);
  }
  const out = new Uint8Array(KEY_BYTES_LENGTH);
  for (let i = 0; i < KEY_BYTES_LENGTH; i++) {
    const hi = letterToNibble(letters.charAt(2 * i));
    const lo = letterToNibble(letters.charAt(2 * i + 1));
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function decodeKey(bytes: Uint8Array): string {
  if (bytes.length !== KEY_BYTES_LENGTH) {
    throw new RangeError(`expected ${KEY_BYTES_LENGTH} bytes, got ${bytes.length}`);
  }
  let out = "";
  for (const b of bytes) {
    out += nibbleToLetter((b >> 4) & 0x0f) + nibbleToLetter(b & 0x0f);
  }
  return out;
}

export interface ParsedKey {
  kRaw: Uint8Array;
  checksum: number;
}

export function parseKey(letters: string): ParsedKey {
  const bytes = encodeKey(letters);
  const kRaw = bytes.slice(0, K_RAW_LENGTH);
  const checksum = bytes[K_RAW_LENGTH]!;
  const expected = computeChecksum(kRaw);
  if (checksum !== expected) {
    throw new InvalidKeyError("Key is Invalid");
  }
  return { kRaw, checksum };
}

// Take a 30-letter key body (k_raw as letters) and return the full 32-letter
// valid key with the 2-letter checksum appended. Useful for tests and for
// operators who have been issued raw material without a checksum.
export function appendChecksum(body30: string): string {
  if (body30.length !== 30) {
    throw new InvalidKeyError(`expected 30 letters, got ${body30.length}`);
  }
  const kRaw = new Uint8Array(K_RAW_LENGTH);
  for (let i = 0; i < K_RAW_LENGTH; i++) {
    const hi = letterToNibble(body30.charAt(2 * i));
    const lo = letterToNibble(body30.charAt(2 * i + 1));
    kRaw[i] = (hi << 4) | lo;
  }
  const csum = computeChecksum(kRaw);
  return body30 + nibbleToLetter((csum >> 4) & 0x0f) + nibbleToLetter(csum & 0x0f);
}
