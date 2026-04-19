// Thin wrappers around crypto primitives. Same module runs in Node (tests)
// and in the browser (emulator host). We avoid `node:crypto` on purpose —
// Vite externalizes it for the browser bundle and calling it throws
// "Module externalized for browser compatibility" at runtime.
//
// SHA-256 and HMAC-SHA-256 are implemented synchronously in pure JS. Every
// caller (FEC/Mi checksum, Updater, Authentication) relies on sync return
// values; going async here would ripple through the entire pipeline.
//
// Random bytes come from Web Crypto (`globalThis.crypto.getRandomValues`),
// present in Node ≥ 20 and every modern browser.
//
// DES lives here because OpenSSL 3 (Node 22) disables single-DES by default
// and browsers never had it. des.js is a pure-JS implementation that works
// identically in Node and in the browser — the same code path used for
// tests will run in the final emulator.

// @ts-expect-error — des.js has no bundled types; shape is documented inline.
import desjs from "des.js";

// ───────── SHA-256 (FIPS 180-4) ─────────

const SHA256_K = /* @__PURE__ */ new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(data: Uint8Array): Uint8Array {
  const bitLenLo = (data.length * 8) >>> 0;
  const bitLenHi = Math.floor((data.length * 8) / 0x100_000_000) >>> 0;
  const rem = data.length % 64;
  const padLen = rem < 56 ? 56 - rem : 120 - rem;
  const total = data.length + padLen + 8;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, bitLenHi);
  view.setUint32(total - 4, bitLenLo);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(chunk + i * 4);
    for (let i = 16; i < 64; i++) {
      const x15 = w[i - 15]!, x2 = w[i - 2]!;
      const s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3);
      const s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!;
    let e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

const HMAC_BLOCK = 64;

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  // RFC 2104: if key > block size, hash it first; then zero-pad to block size.
  const k = key.length > HMAC_BLOCK ? sha256(key) : key;
  const padded = new Uint8Array(HMAC_BLOCK);
  padded.set(k);
  const iPad = new Uint8Array(HMAC_BLOCK);
  const oPad = new Uint8Array(HMAC_BLOCK);
  for (let i = 0; i < HMAC_BLOCK; i++) {
    iPad[i] = padded[i]! ^ 0x36;
    oPad[i] = padded[i]! ^ 0x5c;
  }
  const inner = new Uint8Array(HMAC_BLOCK + data.length);
  inner.set(iPad);
  inner.set(data, HMAC_BLOCK);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(HMAC_BLOCK + innerHash.length);
  outer.set(oPad);
  outer.set(innerHash, HMAC_BLOCK);
  return sha256(outer);
}

// ───────── Random (Web Crypto) ─────────

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const g = globalThis as { crypto?: { getRandomValues?(a: Uint8Array): void } };
  if (!g.crypto || typeof g.crypto.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is unavailable");
  }
  g.crypto.getRandomValues(buf);
  return buf;
}

// DES-CBC without padding. Callers are responsible for padding plaintext to
// a multiple of 8 bytes (we use PKCS#7 in DesBackend). The 7-byte input key
// is the raw 56-bit DES key; we expand to the 8-byte form des.js expects by
// inserting a parity bit in each byte's LSB.
export function desCbcEncrypt(
  key7: Uint8Array,
  iv8: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  assertKeyIvShape(key7, iv8);
  if (plaintext.length === 0 || plaintext.length % 8 !== 0) {
    throw new RangeError(
      `plaintext must be a positive multiple of 8 bytes, got ${plaintext.length}`,
    );
  }
  const cipher = desjs.CBC.instantiate(desjs.DES).create({
    type: "encrypt",
    key: expandDesKeyWithParity(key7),
    iv: Array.from(iv8),
    padding: false,
  });
  const out = cipher.update(Array.from(plaintext)).concat(cipher.final());
  return Uint8Array.from(out);
}

export function desCbcDecrypt(
  key7: Uint8Array,
  iv8: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  assertKeyIvShape(key7, iv8);
  if (ciphertext.length === 0 || ciphertext.length % 8 !== 0) {
    throw new RangeError(
      `ciphertext must be a positive multiple of 8 bytes, got ${ciphertext.length}`,
    );
  }
  const decipher = desjs.CBC.instantiate(desjs.DES).create({
    type: "decrypt",
    key: expandDesKeyWithParity(key7),
    iv: Array.from(iv8),
    padding: false,
  });
  const out = decipher.update(Array.from(ciphertext)).concat(decipher.final());
  return Uint8Array.from(out);
}

function assertKeyIvShape(key7: Uint8Array, iv8: Uint8Array): void {
  if (key7.length !== 7) throw new RangeError(`DES key must be 7 bytes, got ${key7.length}`);
  if (iv8.length !== 8) throw new RangeError(`DES IV must be 8 bytes, got ${iv8.length}`);
}

// Pack 56 input bits into 64 output bits with a parity bit every 8th
// position. Parity bits are set for odd parity (not cryptographically
// meaningful — DES strength is unaffected — but des.js assumes them).
function expandDesKeyWithParity(key7: Uint8Array): Uint8Array {
  const out = new Uint8Array(8);
  let bitBuf = 0;
  let bitCount = 0;
  let readIdx = 0;
  for (let i = 0; i < 8; i++) {
    while (bitCount < 7) {
      bitBuf = (bitBuf << 8) | (key7[readIdx++] ?? 0);
      bitCount += 8;
    }
    const seven = (bitBuf >>> (bitCount - 7)) & 0x7f;
    bitCount -= 7;
    bitBuf &= (1 << bitCount) - 1;
    let parity = 1;
    for (let b = 0; b < 7; b++) parity ^= (seven >>> b) & 1;
    out[i] = (seven << 1) | parity;
  }
  return out;
}
