// GF(2^8) arithmetic tables used by the Reed-Solomon encoder/decoder.
// Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1 (0x11d), matching
// CCSDS telemetry, JPEG/MPEG, and the de-facto standard used across most
// 1980s RS implementations.
//
// Field element 0 has no log; LOG[0] is unused. EXP has 512 entries (two
// full copies) so exp lookups can index without a mod.

export const FIELD_SIZE = 256;
export const FIELD_PRIMITIVE = 0x11d;
export const GENERATOR = 0x02; // α = 2 is primitive under 0x11d

export const EXP: Uint8Array = new Uint8Array(FIELD_SIZE * 2);
export const LOG: Uint8Array = new Uint8Array(FIELD_SIZE);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= FIELD_PRIMITIVE;
  }
  // Extend EXP so that EXP[a+b] works for a,b in [0,254] without modulo.
  for (let i = 255; i < FIELD_SIZE * 2; i++) EXP[i] = EXP[i - 255]!;
  // EXP[255] wraps to EXP[0] = 1; both copies agree. LOG[0] is left as 0.
}

export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("gfDiv: divide by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!;
}

export function gfPow(a: number, n: number): number {
  if (a === 0) return n === 0 ? 1 : 0;
  const l = LOG[a]!;
  let e = (l * n) % 255;
  if (e < 0) e += 255;
  return EXP[e]!;
}

export function gfInv(a: number): number {
  if (a === 0) throw new RangeError("gfInv: zero has no inverse");
  return EXP[255 - LOG[a]!]!;
}

// Polynomial operations. Polynomials are little-endian (coefficient of x^i
// at index i). This matches the standard BM / Forney writeup.

export function polyAdd(p: Uint8Array, q: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < out.length; i++) {
    out[i] = (p[i] ?? 0) ^ (q[i] ?? 0);
  }
  return out;
}

export function polyScale(p: Uint8Array, scalar: number): Uint8Array {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = gfMul(p[i]!, scalar);
  return out;
}

export function polyMul(p: Uint8Array, q: Uint8Array): Uint8Array {
  if (p.length === 0 || q.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i++) {
    const pi = p[i]!;
    if (pi === 0) continue;
    for (let j = 0; j < q.length; j++) {
      out[i + j]! ^= gfMul(pi, q[j]!);
    }
  }
  return out;
}

/** Evaluate p(x) at a single field point using Horner's rule. */
export function polyEval(p: Uint8Array, x: number): number {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) {
    y = gfAdd(gfMul(y, x), p[i]!);
  }
  return y;
}
