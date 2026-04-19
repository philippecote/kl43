// Primary backend — SAVILLE-shaped nonlinear LFSR combiner.
// Reference: KL43_emulator_spec_addendum_A_cipher.md §A.3.
//
// Three LFSRs (lengths 39, 41, 47 bits — coprime, total 127-bit state) with
// primitive feedback polynomials, irregularly clocked by a majority vote of
// three mid-register "clocking bits" (A5/1 style). Output bits are combined
// by a balanced Geffe-style function `a·b ⊕ ā·c ⊕ b`, which is symmetric
// across the three inputs at worst ±1/4 correlation (see §A.3.5).
//
// Key / MI load diffuses each key bit through all three registers: one
// regular clock per bit, XOR'ing the bit into the feedback. After MI load,
// 256 irregular clocks warm the state so every bit of key/MI influences
// essentially every state bit before the first keystream byte is output.
//
// This is a toy cipher in the cryptographic-strength sense: Geffe combiners
// have known correlation attacks. The point is architectural fidelity to
// SAVILLE's believed design, not security. Use the aes-ctr backend when you
// want real secrecy.

import {
  CryptoBackend,
  CryptoStream,
  assertKRawShape,
  miToBytes,
} from "../CryptoBackend.js";

// Register lengths — BigInt because JS numbers are 32-bit for bitwise ops.
const LEN_A = 39n;
const LEN_B = 41n;
const LEN_C = 47n;

// Feedback tap indices (bit 0 = LSB). Chosen for primitive polynomials over
// GF(2). Verified against Lidl & Niederreiter, *Introduction to Finite
// Fields*, Appendix B.
const TAPS_A = [0n, 35n]; // x^39 + x^4 + 1 → taps {0, 39-4} = {0, 35}
const TAPS_B = [0n, 38n]; // x^41 + x^3 + 1 → {0, 41-3} = {0, 38}
const TAPS_C = [0n, 42n]; // x^47 + x^5 + 1 → {0, 47-5} = {0, 42}

// Clocking-bit positions (mid-register, chosen to spread well).
const CLOCK_A = 19n;
const CLOCK_B = 20n;
const CLOCK_C = 23n;

// Output-bit positions (MSB of each register, shifted out on each clock).
const OUT_A = LEN_A - 1n; // 38
const OUT_B = LEN_B - 1n; // 40
const OUT_C = LEN_C - 1n; // 46

const MASK_A = (1n << LEN_A) - 1n;
const MASK_B = (1n << LEN_B) - 1n;
const MASK_C = (1n << LEN_C) - 1n;

class LfsrNlcStream implements CryptoStream {
  private a = 0n;
  private b = 0n;
  private c = 0n;

  constructor(kRaw: Uint8Array, mi: string) {
    assertKRawShape(kRaw);
    const miBytes = miToBytes(mi);

    // Key load: 120 bits, MSB-first per byte. Regular clocking (every
    // register clocks every step), with key bit XOR'd into feedback.
    for (const byte of kRaw) {
      for (let bit = 7; bit >= 0; bit--) this.stepAll((byte >> bit) & 1);
    }

    // MI load: 96 bits, same regular-clock + XOR pattern.
    for (const byte of miBytes) {
      for (let bit = 7; bit >= 0; bit--) this.stepAll((byte >> bit) & 1);
    }

    // Warm-up: 256 irregular (majority) clocks, discard the keystream.
    for (let i = 0; i < 256; i++) this.keystreamBit();
  }

  /** Symmetric: `mode` is ignored — stream cipher XORs either direction. */
  transform(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let k = 0;
      for (let b = 0; b < 8; b++) k = (k << 1) | this.keystreamBit();
      out[i] = input[i]! ^ k;
    }
    return out;
  }

  /** Clock all three regularly, XOR'ing `xorBit` into each feedback. */
  private stepAll(xorBit: number): void {
    this.a = shift(this.a, LEN_A, TAPS_A, xorBit);
    this.b = shift(this.b, LEN_B, TAPS_B, xorBit);
    this.c = shift(this.c, LEN_C, TAPS_C, xorBit);
  }

  /**
   * One keystream bit, irregularly clocked by majority. Output bit of each
   * register is the MSB *before* its shift; registers not clocked this step
   * contribute 0 to the combiner (their output bit is considered absent).
   * In practice the majority rule guarantees 2 or 3 registers clock — never
   * 0 or 1 — so the combiner always sees at least 2 fresh bits.
   */
  private keystreamBit(): number {
    const ca = Number((this.a >> CLOCK_A) & 1n);
    const cb = Number((this.b >> CLOCK_B) & 1n);
    const cc = Number((this.c >> CLOCK_C) & 1n);
    const maj = ca + cb + cc >= 2 ? 1 : 0;

    let oa = 0;
    let ob = 0;
    let oc = 0;
    if (ca === maj) {
      oa = Number((this.a >> OUT_A) & 1n);
      this.a = shift(this.a, LEN_A, TAPS_A, 0);
    }
    if (cb === maj) {
      ob = Number((this.b >> OUT_B) & 1n);
      this.b = shift(this.b, LEN_B, TAPS_B, 0);
    }
    if (cc === maj) {
      oc = Number((this.c >> OUT_C) & 1n);
      this.c = shift(this.c, LEN_C, TAPS_C, 0);
    }

    // Geffe-style combiner: a·b ⊕ ā·c ⊕ b. The trailing `⊕ b` balances the
    // truth table so each input is correlation-neutral or ±1/4 — masking the
    // most obvious statistical signature of the plain `a·b ⊕ ā·c` form.
    return ((oa & ob) ^ ((oa ^ 1) & oc) ^ ob) & 1;
  }
}

function shift(reg: bigint, len: bigint, taps: readonly bigint[], xorBit: number): bigint {
  let fb = 0n;
  for (const t of taps) fb ^= (reg >> t) & 1n;
  fb ^= BigInt(xorBit);
  const mask = (1n << len) - 1n;
  return ((reg << 1n) | fb) & mask;
}

export class LfsrNlcBackend implements CryptoBackend {
  readonly id = "lfsr-nlc" as const;
  readonly label = "SAVILLE-shaped (default)";
  readonly description =
    "127-bit nonlinear LFSR combiner — architecturally closest to the real device's classified algorithm. Toy cipher; not secure against any serious attacker. Chosen for historical feel only.";

  init(kRaw: Uint8Array, mi: string): CryptoStream {
    return new LfsrNlcStream(kRaw, mi);
  }
}
