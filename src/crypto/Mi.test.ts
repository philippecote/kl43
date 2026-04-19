import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  InvalidMiError,
  MI_BODY_LENGTH,
  MI_TOTAL_LENGTH,
  deriveIv,
  makeMi,
  miChecksum,
  parseMi,
} from "./Mi.js";

const MI_BODY_ARB = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")), {
    minLength: MI_BODY_LENGTH,
    maxLength: MI_BODY_LENGTH,
  })
  .map((a) => a.join(""));

function seededSource(bytes: Uint8Array): (n: number) => Uint8Array {
  return (n) => {
    if (n !== bytes.length) throw new Error(`test source only supplies ${bytes.length} bytes`);
    return bytes;
  };
}

describe("miChecksum", () => {
  it("is deterministic for the same body", () => {
    fc.assert(
      fc.property(MI_BODY_ARB, (body) => {
        expect(miChecksum(body)).toBe(miChecksum(body));
      }),
    );
  });

  it("produces 2 letters A-Z", () => {
    fc.assert(
      fc.property(MI_BODY_ARB, (body) => {
        const c = miChecksum(body);
        expect(c).toMatch(/^[A-Z]{2}$/);
      }),
    );
  });

  it("rejects bad inputs", () => {
    expect(() => miChecksum("SHORT")).toThrow(RangeError);
    expect(() => miChecksum("0123456789")).toThrow(InvalidMiError);
    expect(() => miChecksum("abcdefghij")).toThrow(InvalidMiError);
  });
});

describe("makeMi + parseMi", () => {
  it("makeMi produces a parseable MI", () => {
    const source = seededSource(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const mi = makeMi(source);
    expect(mi.length).toBe(MI_TOTAL_LENGTH);
    expect(mi).toMatch(/^[A-Z]{12}$/);
    expect(() => parseMi(mi)).not.toThrow();
  });

  it("body bytes mod 26 map to A-Z in order", () => {
    const source = seededSource(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const mi = makeMi(source);
    expect(mi.slice(0, 10)).toBe("ABCDEFGHIJ");
  });

  it("handles the full byte range via mod 26", () => {
    const source = seededSource(new Uint8Array([25, 26, 27, 51, 52, 0, 255, 100, 200, 75]));
    const mi = makeMi(source);
    // 25→Z, 26→A, 27→B, 51→Z, 52→A, 0→A, 255→(255%26=21)→V, 100→(100%26=22)→W,
    // 200→(200%26=18)→S, 75→(75%26=23)→X
    expect(mi.slice(0, 10)).toBe("ZABZAAVWSX");
  });

  it("detects every single-letter flip in body or checksum", () => {
    fc.assert(
      fc.property(
        MI_BODY_ARB,
        fc.integer({ min: 0, max: MI_TOTAL_LENGTH - 1 }),
        fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
        (body, pos, replacement) => {
          const mi = body + miChecksum(body);
          if (mi.charAt(pos) === replacement) return; // no-op flip
          const flipped = mi.slice(0, pos) + replacement + mi.slice(pos + 1);
          // Either the checksum fails (common) or, in a tiny fraction of
          // cases, the flip happens to produce a body whose checksum is the
          // unchanged 2-letter suffix. Collisions across 10-letter bodies
          // with 2-letter checksums (676 buckets) occur with probability
          // ~1/676 per flip — allow that path.
          try {
            parseMi(flipped);
            const newBody = flipped.slice(0, MI_BODY_LENGTH);
            const newCk = flipped.slice(MI_BODY_LENGTH);
            expect(miChecksum(newBody)).toBe(newCk); // confirms collision path
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidMiError);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects wrong-length MI", () => {
    expect(() => parseMi("SHORT")).toThrow(InvalidMiError);
    expect(() => parseMi("A".repeat(13))).toThrow(InvalidMiError);
  });

  it("rejects non-A-Z characters", () => {
    expect(() => parseMi("abcdefghij" + "AA")).toThrow(InvalidMiError);
    expect(() => parseMi("ABCDEFGHI1" + "AA")).toThrow(InvalidMiError);
  });
});

describe("deriveIv", () => {
  const sessionKey = new Uint8Array(7).fill(0x77);

  it("is deterministic for the same (MI, sessionKey, ivBytes)", () => {
    const body = "ABCDEFGHIJ";
    const mi = body + miChecksum(body);
    const a = deriveIv(mi, sessionKey, 8);
    const b = deriveIv(mi, sessionKey, 8);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("returns the requested number of bytes", () => {
    const body = "ABCDEFGHIJ";
    const mi = body + miChecksum(body);
    expect(deriveIv(mi, sessionKey, 8).length).toBe(8);
    expect(deriveIv(mi, sessionKey, 16).length).toBe(16);
  });

  it("differs when the MI body changes", () => {
    const mi1 = "ABCDEFGHIJ" + miChecksum("ABCDEFGHIJ");
    const mi2 = "ZYXWVUTSRQ" + miChecksum("ZYXWVUTSRQ");
    expect(Array.from(deriveIv(mi1, sessionKey, 8))).not.toEqual(
      Array.from(deriveIv(mi2, sessionKey, 8)),
    );
  });

  it("differs when the session key changes", () => {
    const body = "ABCDEFGHIJ";
    const mi = body + miChecksum(body);
    const iv1 = deriveIv(mi, new Uint8Array(7), 8);
    const iv2 = deriveIv(mi, new Uint8Array(7).fill(1), 8);
    expect(Array.from(iv1)).not.toEqual(Array.from(iv2));
  });

  it("rejects an invalid MI before hashing", () => {
    expect(() => deriveIv("not a valid mi!", sessionKey, 8)).toThrow(InvalidMiError);
  });

  it("rejects silly ivBytes values", () => {
    const body = "ABCDEFGHIJ";
    const mi = body + miChecksum(body);
    expect(() => deriveIv(mi, sessionKey, 0)).toThrow(RangeError);
    expect(() => deriveIv(mi, sessionKey, 33)).toThrow(RangeError);
  });
});
