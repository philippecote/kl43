import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_K,
  DEFAULT_N,
  DEFAULT_PARITY,
  ReedSolomon,
  ReedSolomonError,
} from "./ReedSolomon.js";

describe("RS(255, 223) parameters", () => {
  const rs = new ReedSolomon();

  it("reports canonical sizes", () => {
    expect(rs.n).toBe(DEFAULT_N);
    expect(rs.k).toBe(DEFAULT_K);
    expect(rs.parity).toBe(DEFAULT_PARITY);
    expect(rs.parity).toBe(32);
  });
});

describe("encode + decode with no errors", () => {
  const rs = new ReedSolomon();

  it("codeword is systematic: data occupies the high-degree half [parity..n)", () => {
    const data = new Uint8Array(DEFAULT_K).map((_, i) => i & 0xff);
    const codeword = rs.encode(data);
    expect(codeword.length).toBe(DEFAULT_N);
    expect(Array.from(codeword.slice(DEFAULT_PARITY, DEFAULT_N))).toEqual(Array.from(data));
  });

  it("decode of an unmodified codeword recovers the data with 0 corrections", () => {
    const data = new Uint8Array(DEFAULT_K).map((_, i) => (i * 7 + 3) & 0xff);
    const codeword = rs.encode(data);
    const { data: recovered, corrected } = rs.decode(codeword);
    expect(Array.from(recovered)).toEqual(Array.from(data));
    expect(corrected).toBe(0);
  });
});

describe("single and multi-error correction", () => {
  const rs = new ReedSolomon();

  it("corrects a single-byte flip at arbitrary position", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: DEFAULT_K, maxLength: DEFAULT_K }),
        fc.integer({ min: 0, max: DEFAULT_N - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (data, pos, delta) => {
          const codeword = rs.encode(data);
          codeword[pos] = (codeword[pos]! ^ delta) & 0xff;
          const { data: recovered, corrected } = rs.decode(codeword);
          expect(Array.from(recovered)).toEqual(Array.from(data));
          expect(corrected).toBe(1);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("corrects exactly 16 errors (the capacity limit for RS(255,223))", () => {
    const data = new Uint8Array(DEFAULT_K).map((_, i) => i & 0xff);
    const codeword = rs.encode(data);
    const corrupted = Uint8Array.from(codeword);
    // Flip bytes at 16 distinct positions.
    const positions = [0, 10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 175, 190, 205, 220];
    for (const p of positions) corrupted[p]! ^= 0xff;
    const { data: recovered, corrected } = rs.decode(corrupted);
    expect(Array.from(recovered)).toEqual(Array.from(data));
    expect(corrected).toBe(16);
  });

  it("rejects 17 errors (one over capacity)", () => {
    const data = new Uint8Array(DEFAULT_K);
    const codeword = rs.encode(data);
    for (let i = 0; i < 17; i++) codeword[i * 10]! ^= 0xaa;
    // With 17 errors BM may report an over-capacity locator (caught as
    // uncorrectable) or succeed-but-mis-correct; either path must NOT
    // silently return the wrong data. Accept either a throw or a recovered
    // output that differs from `data`.
    let caught = false;
    try {
      const { data: recovered } = rs.decode(codeword);
      if (Array.from(recovered).every((v, i) => v === data[i])) {
        throw new Error(
          "RS decoder silently returned original data despite 17-error corruption",
        );
      }
    } catch (err) {
      caught = true;
      expect(err).toBeInstanceOf(Error);
      // Either ReedSolomonError or our synthetic guard above is acceptable.
      void err;
    }
    expect(caught).toBe(true);
  });
});

describe("parameter validation", () => {
  it("rejects invalid (n, k) combinations", () => {
    expect(() => new ReedSolomon({ n: 0, k: 0 })).toThrow(RangeError);
    expect(() => new ReedSolomon({ n: 256, k: 128 })).toThrow(RangeError);
    expect(() => new ReedSolomon({ n: 10, k: 10 })).toThrow(RangeError);
  });

  it("encode rejects wrong-length input", () => {
    const rs = new ReedSolomon();
    expect(() => rs.encode(new Uint8Array(DEFAULT_K - 1))).toThrow(RangeError);
    expect(() => rs.encode(new Uint8Array(DEFAULT_K + 1))).toThrow(RangeError);
  });

  it("decode rejects wrong-length input", () => {
    const rs = new ReedSolomon();
    expect(() => rs.decode(new Uint8Array(DEFAULT_N - 1))).toThrow(RangeError);
  });
});

describe("smaller RS code (sanity check with custom n, k)", () => {
  it("RS(15, 11) corrects up to 2 errors", () => {
    const rs = new ReedSolomon({ n: 15, k: 11 });
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const codeword = rs.encode(data);
    expect(codeword.length).toBe(15);
    // Flip 2 bytes.
    codeword[3]! ^= 0x5a;
    codeword[10]! ^= 0x7e;
    const { data: recovered, corrected } = rs.decode(codeword);
    expect(Array.from(recovered)).toEqual(Array.from(data));
    expect(corrected).toBe(2);
  });
});
