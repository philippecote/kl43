// Reed-Solomon RS(n, k) over GF(2^8) with n ≤ 255, k < n, and up to
// t = (n−k)/2 correctable symbol errors. The default parameters are
// RS(255, 223) — 32 parity bytes per 223 data bytes, correcting 16
// symbol errors per codeword. This matches CCSDS 101.0-B and is the
// historically authentic FEC for 1980s secure-comms gear.
//
// Substitute note (spec §7.3): the real KL-43C wire format's FEC is
// unknown. We pick RS(255,223) because it is the dominant FEC of the era
// and because the code is entirely self-contained — no classified
// generator polynomials or custom interleaving schemes.

import {
  EXP,
  LOG,
  gfAdd,
  gfDiv,
  gfInv,
  gfMul,
  gfPow,
  polyAdd,
  polyEval,
  polyMul,
  polyScale,
} from "./Gf256.js";

export const DEFAULT_N = 255;
export const DEFAULT_K = 223;
export const DEFAULT_PARITY = DEFAULT_N - DEFAULT_K;

export class ReedSolomonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReedSolomonError";
  }
}

export interface RsParams {
  readonly n: number;
  readonly k: number;
}

export class ReedSolomon {
  readonly n: number;
  readonly k: number;
  readonly parity: number;
  private readonly generator: Uint8Array;

  constructor(params: RsParams = { n: DEFAULT_N, k: DEFAULT_K }) {
    const { n, k } = params;
    if (n <= 0 || n > 255) throw new RangeError(`n must be in (0, 255], got ${n}`);
    if (k <= 0 || k >= n) throw new RangeError(`k must be in (0, n), got ${k}`);
    this.n = n;
    this.k = k;
    this.parity = n - k;
    this.generator = buildGenerator(this.parity);
  }

  /**
   * Encode k data bytes into an n-byte codeword. Layout is little-endian
   * by polynomial degree:
   *   codeword[0..parity-1]   = parity (coefficients x^0 .. x^(parity-1))
   *   codeword[parity..n-1]   = data   (coefficients x^parity .. x^(n-1))
   *
   * This is "systematic, parity first" — the data appears verbatim in the
   * high-degree half of the codeword, so decoding without errors just
   * slices off the parity prefix. Position numbering for error-locator
   * math matches the little-endian polynomial convention used by the rest
   * of the module.
   */
  encode(data: Uint8Array): Uint8Array {
    if (data.length !== this.k) {
      throw new RangeError(`data must be ${this.k} bytes, got ${data.length}`);
    }
    // Compute r(x) = (m(x) · x^parity) mod g(x). The reduction on `work`
    // clears the high-degree positions as it runs; the remainder emerges
    // in the low-degree positions [0..parity-1]. Data is preserved
    // separately and recombined at the end.
    const work = new Uint8Array(this.n);
    for (let i = 0; i < this.k; i++) work[this.parity + i] = data[i]!;
    const g = this.generator; // length = parity + 1, g[parity] = 1
    for (let i = this.n - 1; i >= this.parity; i--) {
      const coef = work[i]!;
      if (coef === 0) continue;
      for (let j = 0; j < g.length; j++) {
        work[i - this.parity + j]! ^= gfMul(g[j]!, coef);
      }
    }
    // Systematic codeword: [r_0..r_{parity-1}, data_0..data_{k-1}].
    const codeword = new Uint8Array(this.n);
    for (let i = 0; i < this.parity; i++) codeword[i] = work[i]!;
    for (let i = 0; i < this.k; i++) codeword[this.parity + i] = data[i]!;
    return codeword;
  }

  /**
   * Decode an n-byte received codeword. Returns the corrected k data bytes
   * and the count of corrected errors. Throws if more than ⌊parity/2⌋
   * errors occurred (un-correctable — caller should request retransmit).
   */
  decode(received: Uint8Array): { data: Uint8Array; corrected: number } {
    if (received.length !== this.n) {
      throw new RangeError(`received must be ${this.n} bytes, got ${received.length}`);
    }
    const r = Uint8Array.from(received);
    // Step 1: syndromes S_i = r(α^i) for i = 0 .. parity-1.
    const syndromes = new Uint8Array(this.parity);
    let anyNonZero = false;
    for (let i = 0; i < this.parity; i++) {
      syndromes[i] = polyEval(r, gfPow(2, i));
      if (syndromes[i] !== 0) anyNonZero = true;
    }
    if (!anyNonZero) {
      return { data: r.slice(this.parity, this.n), corrected: 0 };
    }

    // Step 2: Berlekamp-Massey to find error locator Λ(x).
    const locator = berlekampMassey(syndromes);
    const numErrors = locator.length - 1;
    if (numErrors === 0 || numErrors > this.parity / 2) {
      throw new ReedSolomonError(
        `uncorrectable: ${numErrors} errors exceeds capacity ${this.parity / 2}`,
      );
    }

    // Step 3: Chien search. With a little-endian codeword (position p ↔
    // coefficient of x^p) and b=0 syndromes, the error-locator roots live
    // at α^(-p) for each error position p. Evaluate Λ at α^(-i) for every
    // position i ∈ [0, n) and record those where Λ vanishes.
    const errorPositions: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const xInv = gfInv(gfPow(2, i % 255) || 1);
      if (polyEval(locator, xInv) === 0) errorPositions.push(i);
    }
    if (errorPositions.length !== numErrors) {
      throw new ReedSolomonError(
        `uncorrectable: Chien found ${errorPositions.length} roots, expected ${numErrors}`,
      );
    }

    // Step 4: Forney — compute error magnitudes and apply.
    const magnitudes = forney(syndromes, locator, errorPositions);
    for (let i = 0; i < errorPositions.length; i++) {
      r[errorPositions[i]!]! ^= magnitudes[i]!;
    }

    // Step 5: verify all syndromes are now zero.
    for (let i = 0; i < this.parity; i++) {
      if (polyEval(r, gfPow(2, i)) !== 0) {
        throw new ReedSolomonError("uncorrectable: residual syndrome after correction");
      }
    }

    return { data: r.slice(this.parity, this.n), corrected: numErrors };
  }
}

// Build generator polynomial g(x) = ∏_{i=0}^{parity-1} (x − α^i).
// Result is length (parity+1), little-endian coefficients.
function buildGenerator(parity: number): Uint8Array {
  let g: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < parity; i++) {
    const factor = new Uint8Array([gfPow(2, i), 1]); // (α^i + x)
    g = polyMul(g, factor);
  }
  return g;
}

// Berlekamp-Massey over GF(256). Returns the error locator polynomial Λ(x)
// in little-endian form with Λ(0) = 1. Length of output is numErrors + 1.
function berlekampMassey(syndromes: Uint8Array): Uint8Array {
  let lambda: Uint8Array = new Uint8Array([1]);
  let b: Uint8Array = new Uint8Array([1]);
  let L = 0;
  let m = 1;
  let previousDiscrepancy = 1;

  for (let n = 0; n < syndromes.length; n++) {
    let delta = syndromes[n]!;
    for (let i = 1; i <= L; i++) {
      delta = gfAdd(delta, gfMul(lambda[i] ?? 0, syndromes[n - i]!));
    }
    if (delta === 0) {
      m++;
    } else if (2 * L <= n) {
      const t = lambda;
      // lambda = lambda - (delta / prev_disc) * x^m * b
      const coef = gfDiv(delta, previousDiscrepancy);
      const shiftedB = new Uint8Array(b.length + m);
      for (let i = 0; i < b.length; i++) shiftedB[i + m] = b[i]!;
      lambda = polyAdd(lambda, polyScale(shiftedB, coef));
      L = n + 1 - L;
      b = t;
      previousDiscrepancy = delta;
      m = 1;
    } else {
      const coef = gfDiv(delta, previousDiscrepancy);
      const shiftedB = new Uint8Array(b.length + m);
      for (let i = 0; i < b.length; i++) shiftedB[i + m] = b[i]!;
      lambda = polyAdd(lambda, polyScale(shiftedB, coef));
      m++;
    }
  }

  // Trim trailing zeros so degree equals L.
  let deg = lambda.length - 1;
  while (deg > 0 && lambda[deg] === 0) deg--;
  return lambda.slice(0, deg + 1);
}

// Forney algorithm. Computes magnitude for each error position. Inputs:
// syndromes, error-locator Λ(x), and the list of error positions. Output:
// magnitudes indexed in the same order as `positions`.
function forney(
  syndromes: Uint8Array,
  lambda: Uint8Array,
  positions: number[],
): Uint8Array {
  // Compute error evaluator Ω(x) = (S(x) * Λ(x)) mod x^(2t).
  const s = syndromes;
  const product = polyMul(s, lambda);
  const omega = product.slice(0, s.length);

  // Formal derivative Λ'(x): coefficients of odd-index terms in GF(2^m)
  // via d/dx (sum a_i x^i) = sum i*a_i x^(i-1); in char 2, even i
  // contribute 0 so only odd-i terms survive, becoming a_i x^(i-1).
  const lambdaPrime = new Uint8Array(Math.max(lambda.length - 1, 1));
  for (let i = 1; i < lambda.length; i++) {
    if ((i & 1) === 1) lambdaPrime[i - 1] = lambda[i]!;
  }

  const magnitudes = new Uint8Array(positions.length);
  for (let idx = 0; idx < positions.length; idx++) {
    const pos = positions[idx]!;
    const xp = gfPow(2, pos % 255);         // X_p = α^p
    const xpInv = gfInv(xp);                 // α^(-p)
    const num = polyEval(omega, xpInv);
    const den = polyEval(lambdaPrime, xpInv);
    if (den === 0) throw new ReedSolomonError("Forney denominator zero");
    // Forney for b=0 syndromes: e_p = X_p · Ω(X_p^{-1}) / Λ'(X_p^{-1}).
    // In char-2 fields the sign of the identity −X_p^{1−b} reduces to +X_p.
    magnitudes[idx] = gfMul(xp, gfDiv(num, den));
  }
  return magnitudes;
}

// Expose internals for tests. These are implementation details and should
// not be imported by application code.
export const __testInternals = { buildGenerator, berlekampMassey, forney };

void EXP;
void LOG;
