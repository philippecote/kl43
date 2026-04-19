import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  EXP,
  FIELD_SIZE,
  LOG,
  gfAdd,
  gfDiv,
  gfInv,
  gfMul,
  gfPow,
  polyAdd,
  polyEval,
  polyMul,
} from "./Gf256.js";

describe("GF(256) table sanity", () => {
  it("LOG and EXP are inverses for nonzero elements", () => {
    for (let a = 1; a < FIELD_SIZE; a++) {
      expect(EXP[LOG[a]!]).toBe(a);
    }
  });

  it("EXP[255] wraps back to EXP[0] = 1", () => {
    expect(EXP[0]).toBe(1);
    expect(EXP[255]).toBe(1);
  });
});

describe("field axioms (property)", () => {
  const byte = fc.integer({ min: 0, max: 255 });
  const nonzero = fc.integer({ min: 1, max: 255 });

  it("addition is XOR, commutative and associative", () => {
    fc.assert(
      fc.property(byte, byte, byte, (a, b, c) => {
        expect(gfAdd(a, b)).toBe(a ^ b);
        expect(gfAdd(a, b)).toBe(gfAdd(b, a));
        expect(gfAdd(gfAdd(a, b), c)).toBe(gfAdd(a, gfAdd(b, c)));
      }),
    );
  });

  it("multiplication is commutative and associative", () => {
    fc.assert(
      fc.property(byte, byte, byte, (a, b, c) => {
        expect(gfMul(a, b)).toBe(gfMul(b, a));
        expect(gfMul(gfMul(a, b), c)).toBe(gfMul(a, gfMul(b, c)));
      }),
    );
  });

  it("1 is the multiplicative identity", () => {
    fc.assert(
      fc.property(byte, (a) => {
        expect(gfMul(a, 1)).toBe(a);
      }),
    );
  });

  it("distributivity: a*(b+c) = a*b + a*c", () => {
    fc.assert(
      fc.property(byte, byte, byte, (a, b, c) => {
        expect(gfMul(a, gfAdd(b, c))).toBe(gfAdd(gfMul(a, b), gfMul(a, c)));
      }),
    );
  });

  it("nonzero elements have multiplicative inverses", () => {
    fc.assert(
      fc.property(nonzero, (a) => {
        expect(gfMul(a, gfInv(a))).toBe(1);
      }),
    );
  });

  it("division is the inverse of multiplication", () => {
    fc.assert(
      fc.property(byte, nonzero, (a, b) => {
        expect(gfDiv(gfMul(a, b), b)).toBe(a);
      }),
    );
  });

  it("gfPow matches repeated multiplication", () => {
    fc.assert(
      fc.property(byte, fc.integer({ min: 0, max: 10 }), (a, n) => {
        let expected = 1;
        for (let i = 0; i < n; i++) expected = gfMul(expected, a);
        expect(gfPow(a, n)).toBe(expected);
      }),
    );
  });

  it("α = 2 is primitive: α^255 = 1 and α^k != 1 for 0 < k < 255", () => {
    expect(gfPow(2, 255)).toBe(1);
    const seen = new Set<number>();
    for (let k = 0; k < 255; k++) seen.add(gfPow(2, k));
    expect(seen.size).toBe(255); // all nonzero elements covered
  });
});

describe("polynomial ops", () => {
  it("polyAdd is XOR coefficient-wise, with length = max", () => {
    const p = new Uint8Array([1, 2, 3]);
    const q = new Uint8Array([4, 5]);
    expect(Array.from(polyAdd(p, q))).toEqual([1 ^ 4, 2 ^ 5, 3]);
  });

  it("polyMul(p, 1) = p", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 10 }), (p) => {
        const result = polyMul(p, new Uint8Array([1]));
        expect(Array.from(result)).toEqual(Array.from(p));
      }),
    );
  });

  it("polyEval(p, 0) = p[0] (constant term)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 10 }), (p) => {
        expect(polyEval(p, 0)).toBe(p[0]!);
      }),
    );
  });

  it("polyEval(p*q, x) = polyEval(p, x) * polyEval(q, x)", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 8 }),
        fc.uint8Array({ minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 255 }),
        (p, q, x) => {
          const lhs = polyEval(polyMul(p, q), x);
          const rhs = gfMul(polyEval(p, x), polyEval(q, x));
          expect(lhs).toBe(rhs);
        },
      ),
    );
  });
});
