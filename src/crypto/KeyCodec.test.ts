import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  InvalidKeyError,
  K_RAW_LENGTH,
  appendChecksum,
  computeChecksum,
  decodeKey,
  encodeKey,
  letterToNibble,
  nibbleToLetter,
  parseKey,
} from "./KeyCodec.js";

const LETTER = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
const KEY_BODY_30 = fc.array(LETTER, { minLength: 30, maxLength: 30 }).map((a) => a.join(""));

describe("letterToNibble / nibbleToLetter", () => {
  it("maps A-P to 0..15 directly", () => {
    const canonical = "ABCDEFGHIJKLMNOP";
    for (let i = 0; i < 16; i++) {
      expect(letterToNibble(canonical[i]!)).toBe(i);
      expect(nibbleToLetter(i)).toBe(canonical[i]);
    }
  });

  it("aliases Q-Z to A-J (spec §6.2)", () => {
    const aliases: Array<[string, string]> = [
      ["Q", "A"], ["R", "B"], ["S", "C"], ["T", "D"], ["U", "E"],
      ["V", "F"], ["W", "G"], ["X", "H"], ["Y", "I"], ["Z", "J"],
    ];
    for (const [alias, canonical] of aliases) {
      expect(letterToNibble(alias)).toBe(letterToNibble(canonical));
    }
  });

  it("rejects lowercase, digits, punctuation", () => {
    for (const bad of ["a", "z", "0", "9", " ", ",", "?"]) {
      expect(() => letterToNibble(bad)).toThrow(InvalidKeyError);
    }
  });

  it("rejects out-of-range nibbles", () => {
    expect(() => nibbleToLetter(-1)).toThrow(RangeError);
    expect(() => nibbleToLetter(16)).toThrow(RangeError);
    expect(() => nibbleToLetter(1.5)).toThrow(RangeError);
  });
});

describe("computeChecksum", () => {
  it("sums 15 zero bytes to 0", () => {
    expect(computeChecksum(new Uint8Array(K_RAW_LENGTH))).toBe(0);
  });

  it("sums 15 bytes of 0x01 to 15", () => {
    expect(computeChecksum(new Uint8Array(K_RAW_LENGTH).fill(0x01))).toBe(15);
  });

  it("wraps mod 256", () => {
    const buf = new Uint8Array(K_RAW_LENGTH).fill(0xff);
    // 15 * 255 = 3825 = 14 * 256 + 241
    expect(computeChecksum(buf)).toBe(241);
  });

  it("rejects wrong length", () => {
    expect(() => computeChecksum(new Uint8Array(14))).toThrow(RangeError);
    expect(() => computeChecksum(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe("encodeKey / decodeKey", () => {
  it("encodes 32 As to 16 zero bytes", () => {
    const bytes = encodeKey("A".repeat(32));
    expect(Array.from(bytes)).toEqual(new Array(16).fill(0));
  });

  it("encodes 32 Ps to 16 0xFF bytes", () => {
    const bytes = encodeKey("P".repeat(32));
    expect(Array.from(bytes)).toEqual(new Array(16).fill(0xff));
  });

  it("Q-Z aliases produce the same bytes as A-J", () => {
    const aBytes = encodeKey("A".repeat(32));
    const qBytes = encodeKey("Q".repeat(32));
    expect(Array.from(aBytes)).toEqual(Array.from(qBytes));
  });

  it("decode returns canonical (A-P) form; Q-Z round trip collapses to A-J", () => {
    const aliased = "QRSTUVWXYZKLMNOPABCDEFGHIJABCDEF";
    const canonical = "ABCDEFGHIJKLMNOPABCDEFGHIJABCDEF";
    expect(decodeKey(encodeKey(aliased))).toBe(canonical);
  });

  it("encodeKey then decodeKey is identity for canonical letters", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOP".split("")), {
          minLength: 32,
          maxLength: 32,
        }),
        (chars) => {
          const letters = chars.join("");
          expect(decodeKey(encodeKey(letters))).toBe(letters);
        },
      ),
    );
  });

  it("rejects wrong-length input", () => {
    expect(() => encodeKey("A".repeat(31))).toThrow(InvalidKeyError);
    expect(() => encodeKey("A".repeat(33))).toThrow(InvalidKeyError);
    expect(() => encodeKey("")).toThrow(InvalidKeyError);
  });
});

describe("appendChecksum + parseKey", () => {
  it("appendChecksum produces a parseable key (round trip)", () => {
    fc.assert(
      fc.property(KEY_BODY_30, (body) => {
        const key = appendChecksum(body);
        expect(() => parseKey(key)).not.toThrow();
        const parsed = parseKey(key);
        expect(parsed.kRaw.length).toBe(K_RAW_LENGTH);
        expect(parsed.checksum).toBe(computeChecksum(parsed.kRaw));
      }),
    );
  });

  it("any single-letter flip in the 32-letter key is detected (either checksum or alias collapse)", () => {
    // Flipping a letter in the body changes k_raw and almost certainly changes
    // the checksum. Flipping a letter in the checksum changes the checksum.
    // Property: the flip is either (a) rejected by parseKey, OR (b) happens
    // to map to an alias that re-encodes to the same bytes (e.g. A↔Q).
    fc.assert(
      fc.property(
        KEY_BODY_30,
        fc.integer({ min: 0, max: 31 }),
        LETTER,
        (body, pos, replacement) => {
          const key = appendChecksum(body);
          if (key.charAt(pos) === replacement) return; // no-op flip
          const flipped = key.slice(0, pos) + replacement + key.slice(pos + 1);
          const originalBytes = encodeKey(key);
          const flippedBytes = encodeKey(flipped);
          const bytesEqual =
            originalBytes.length === flippedBytes.length &&
            originalBytes.every((b, i) => b === flippedBytes[i]);
          if (bytesEqual) {
            // Alias collision (e.g. replaced A with Q): parseKey still succeeds.
            expect(() => parseKey(flipped)).not.toThrow();
          } else {
            expect(() => parseKey(flipped)).toThrow(InvalidKeyError);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects the well-known wrong-checksum example", () => {
    // All-A body with checksum 'AB' (0x01) — real checksum is 0x00 → 'AA'.
    expect(() => parseKey("A".repeat(30) + "AB")).toThrow(InvalidKeyError);
  });

  it("accepts the all-A known-good key", () => {
    const parsed = parseKey("A".repeat(32));
    expect(Array.from(parsed.kRaw)).toEqual(new Array(15).fill(0));
    expect(parsed.checksum).toBe(0);
  });
});
