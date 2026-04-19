import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DES_BLOCK_BYTES, DES_KEY_BYTES, DesBackend, pkcs7Pad, pkcs7Unpad } from "./DesBackend.js";
import { K_RAW_LENGTH } from "./KeyCodec.js";

const backend = new DesBackend();
const kRawArb = fc.uint8Array({ minLength: K_RAW_LENGTH, maxLength: K_RAW_LENGTH });
const ivArb = fc.uint8Array({ minLength: DES_BLOCK_BYTES, maxLength: DES_BLOCK_BYTES });

describe("DesBackend metadata", () => {
  it("reports DES-CBC with 8-byte blocks and IV", () => {
    expect(backend.algorithm).toBe("DES-CBC");
    expect(backend.blockBytes).toBe(8);
    expect(backend.ivBytes).toBe(8);
  });
});

describe("deriveSessionKey", () => {
  it("returns a 7-byte key", () => {
    const kRaw = new Uint8Array(K_RAW_LENGTH).fill(0x42);
    const key = backend.deriveSessionKey(kRaw);
    expect(key.length).toBe(DES_KEY_BYTES);
  });

  it("is deterministic for the same K_raw", () => {
    fc.assert(
      fc.property(kRawArb, (kRaw) => {
        const a = backend.deriveSessionKey(kRaw);
        const b = backend.deriveSessionKey(kRaw);
        expect(Array.from(a)).toEqual(Array.from(b));
      }),
    );
  });

  it("is sensitive to any byte change in K_raw", () => {
    fc.assert(
      fc.property(
        kRawArb,
        fc.integer({ min: 0, max: K_RAW_LENGTH - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (kRaw, pos, delta) => {
          const flipped = new Uint8Array(kRaw);
          flipped[pos] = (flipped[pos]! + delta) & 0xff;
          const a = backend.deriveSessionKey(kRaw);
          const b = backend.deriveSessionKey(flipped);
          expect(Array.from(a)).not.toEqual(Array.from(b));
        },
      ),
    );
  });

  it("rejects wrong-length K_raw", () => {
    expect(() => backend.deriveSessionKey(new Uint8Array(14))).toThrow(RangeError);
    expect(() => backend.deriveSessionKey(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe("encrypt / decrypt round trip", () => {
  it("round-trips arbitrary-length plaintext", () => {
    fc.assert(
      fc.property(
        kRawArb,
        ivArb,
        fc.uint8Array({ minLength: 0, maxLength: 200 }),
        (kRaw, iv, plaintext) => {
          const key = backend.deriveSessionKey(kRaw);
          const ct = backend.encrypt(key, iv, plaintext);
          expect(ct.length % DES_BLOCK_BYTES).toBe(0);
          expect(ct.length).toBeGreaterThan(0);
          const pt = backend.decrypt(key, iv, ct);
          expect(Array.from(pt)).toEqual(Array.from(plaintext));
        },
      ),
    );
  });

  it("produces different ciphertext for different IVs (same key, same plaintext)", () => {
    const kRaw = new Uint8Array(K_RAW_LENGTH).fill(0xaa);
    const key = backend.deriveSessionKey(kRaw);
    const iv1 = new Uint8Array(8);
    const iv2 = new Uint8Array(8).fill(1);
    const plaintext = new TextEncoder().encode("hello world");
    const ct1 = backend.encrypt(key, iv1, plaintext);
    const ct2 = backend.encrypt(key, iv2, plaintext);
    expect(Array.from(ct1)).not.toEqual(Array.from(ct2));
  });

  it("rejects wrong-length ciphertext on decrypt", () => {
    const key = backend.deriveSessionKey(new Uint8Array(K_RAW_LENGTH));
    const iv = new Uint8Array(8);
    expect(() => backend.decrypt(key, iv, new Uint8Array(0))).toThrow(RangeError);
    expect(() => backend.decrypt(key, iv, new Uint8Array(7))).toThrow(RangeError);
  });

  it("rejects wrong-sized session key and IV", () => {
    const plaintext = new Uint8Array(0);
    expect(() => backend.encrypt(new Uint8Array(6), new Uint8Array(8), plaintext)).toThrow(
      RangeError,
    );
    expect(() => backend.encrypt(new Uint8Array(7), new Uint8Array(7), plaintext)).toThrow(
      RangeError,
    );
  });
});

describe("pkcs7Pad / pkcs7Unpad", () => {
  it("adds a full block of padding when input already aligns", () => {
    const padded = pkcs7Pad(new Uint8Array(8), 8);
    expect(padded.length).toBe(16);
    expect(Array.from(padded.slice(8))).toEqual(new Array(8).fill(8));
  });

  it("round-trips for all lengths up to 4 blocks", () => {
    for (let len = 0; len < 32; len++) {
      const input = new Uint8Array(len).map((_, i) => i & 0xff);
      expect(Array.from(pkcs7Unpad(pkcs7Pad(input, 8), 8))).toEqual(Array.from(input));
    }
  });

  it("rejects invalid pad length (0 or > block size)", () => {
    const bad = new Uint8Array(8).fill(0x00); // pad byte says 0
    expect(() => pkcs7Unpad(bad, 8)).toThrow(RangeError);
    const bad2 = new Uint8Array(8).fill(0x09); // pad byte says 9 > block
    expect(() => pkcs7Unpad(bad2, 8)).toThrow(RangeError);
  });

  it("rejects inconsistent padding bytes", () => {
    const buf = new Uint8Array(8);
    buf[6] = 0x00;
    buf[7] = 0x02; // says pad = 2 but preceding byte is not 2
    expect(() => pkcs7Unpad(buf, 8)).toThrow(RangeError);
  });
});
