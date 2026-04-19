import { describe, expect, it } from "vitest";
import {
  desCbcDecrypt,
  desCbcEncrypt,
  hmacSha256,
  randomBytes,
  sha256,
} from "./primitives.js";

function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("sha256 KAT", () => {
  it("hashes the empty string to the well-known value", () => {
    expect(hex(sha256(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc" to the NIST FIPS 180-4 value', () => {
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("hmacSha256 KAT (RFC 4231)", () => {
  it("test case 1: key=0x0b×20, data='Hi There'", () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(hex(hmacSha256(key, utf8("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("test case 2: key='Jefe', data='what do ya want for nothing?'", () => {
    expect(hex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("desCbcEncrypt / desCbcDecrypt", () => {
  it("round-trips an 8-byte plaintext", () => {
    const key = unhex("00112233445566");
    const iv = unhex("0102030405060708");
    const plaintext = utf8("8bytes!!");
    const ct = desCbcEncrypt(key, iv, plaintext);
    // CBC output length = multiple of 8; no padding at this layer.
    expect(ct.length).toBe(8);
    const pt = desCbcDecrypt(key, iv, ct);
    expect(hex(pt)).toBe(hex(plaintext));
  });

  it("round-trips a 24-byte plaintext across three blocks", () => {
    const key = unhex("fedcba9876543f"); // 7 bytes
    const iv = unhex("1122334455667788");
    const plaintext = utf8("Three blocks exactly!!XX"); // 24 bytes
    expect(plaintext.length).toBe(24);
    const ct = desCbcEncrypt(key, iv, plaintext);
    expect(ct.length).toBe(24);
    expect(hex(desCbcDecrypt(key, iv, ct))).toBe(hex(plaintext));
  });

  it("fixed KAT (self-consistency against des.js implementation)", () => {
    // Locks in the output so regressions in key-parity expansion or in the
    // des.js dependency surface as test failures. Generated once against
    // this build; not a NIST vector.
    const key = unhex("01020304050607");
    const iv = unhex("0000000000000000");
    const plaintext = unhex("0000000000000000");
    expect(hex(desCbcEncrypt(key, iv, plaintext))).toBe("37a63689c4baa728");
  });

  it("rejects wrong-length key", () => {
    expect(() => desCbcEncrypt(new Uint8Array(6), new Uint8Array(8), new Uint8Array(8))).toThrow(
      RangeError,
    );
    expect(() => desCbcEncrypt(new Uint8Array(8), new Uint8Array(8), new Uint8Array(8))).toThrow(
      RangeError,
    );
  });

  it("rejects wrong-length IV", () => {
    expect(() => desCbcEncrypt(new Uint8Array(7), new Uint8Array(7), new Uint8Array(8))).toThrow(
      RangeError,
    );
  });
});

describe("randomBytes", () => {
  it("returns the requested length", () => {
    expect(randomBytes(0).length).toBe(0);
    expect(randomBytes(16).length).toBe(16);
    expect(randomBytes(1024).length).toBe(1024);
  });

  it("is not trivially zero across a large draw (probabilistic)", () => {
    const bytes = randomBytes(256);
    const nonZero = bytes.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);
    expect(nonZero).toBeGreaterThan(200);
  });
});
