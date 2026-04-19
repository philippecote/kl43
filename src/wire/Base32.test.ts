import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BASE32_ALPHABET,
  Base32Error,
  base32Decode,
  base32Encode,
  filterToBase32,
  groupForDisplay,
} from "./Base32.js";

describe("base32Encode / base32Decode round trip", () => {
  it("handles empty input", () => {
    expect(base32Encode(new Uint8Array(0))).toBe("");
    expect(base32Decode("").length).toBe(0);
  });

  it("round-trips arbitrary bytes (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (bytes) => {
        const encoded = base32Encode(bytes);
        const decoded = base32Decode(encoded);
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
      }),
    );
  });

  it("RFC 4648 vector: 'foobar'", () => {
    // 'foobar' → MZXW6YTBOI====== per RFC 4648 §10
    const bytes = new TextEncoder().encode("foobar");
    expect(base32Encode(bytes)).toBe("MZXW6YTBOI======");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI======"))).toBe("foobar");
  });

  it("RFC 4648 vector: 'f' → MY======", () => {
    expect(base32Encode(new TextEncoder().encode("f"))).toBe("MY======");
  });

  it("5 bytes encode to exactly 8 base32 chars (no padding)", () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const encoded = base32Encode(bytes);
    expect(encoded.length).toBe(8);
    expect(encoded).not.toContain("=");
  });

  it("decoder tolerates missing padding", () => {
    const padded = base32Encode(new TextEncoder().encode("f"));
    const unpadded = padded.replace(/=+$/, "");
    expect(Array.from(base32Decode(unpadded))).toEqual(
      Array.from(base32Decode(padded)),
    );
  });

  it("decoder tolerates whitespace (grouped display form)", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const encoded = base32Encode(bytes);
    const grouped = groupForDisplay(encoded);
    expect(grouped).toContain(" ");
    expect(Array.from(base32Decode(grouped))).toEqual(Array.from(bytes));
  });

  it("decoder rejects non-alphabet characters", () => {
    expect(() => base32Decode("ABC1")).toThrow(Base32Error); // '1' not in alphabet
    expect(() => base32Decode("abcd")).toThrow(Base32Error); // lowercase rejected
  });

  it("alphabet has exactly 32 unique characters", () => {
    expect(BASE32_ALPHABET.length).toBe(32);
    expect(new Set(BASE32_ALPHABET).size).toBe(32);
    expect(BASE32_ALPHABET).not.toMatch(/[01]/); // 0/1 excluded to avoid O/L confusion
  });
});

describe("groupForDisplay", () => {
  it("groups into 3-char chunks separated by spaces", () => {
    expect(groupForDisplay("ABCDEFGHI")).toBe("ABC DEF GHI");
    expect(groupForDisplay("ABCDEFG")).toBe("ABC DEF G");
  });

  it("empty input stays empty", () => {
    expect(groupForDisplay("")).toBe("");
  });

  it("matches the manual's example layout (3-char groups)", () => {
    const example = "4ABNFCQWPH6F4EROL2FCA7HY5R466T";
    const grouped = groupForDisplay(example);
    expect(grouped).toBe("4AB NFC QWP H6F 4ER OL2 FCA 7HY 5R4 66T");
  });

  it("rejects non-positive group size", () => {
    expect(() => groupForDisplay("AAA", 0)).toThrow(RangeError);
    expect(() => groupForDisplay("AAA", -1)).toThrow(RangeError);
  });
});

describe("filterToBase32 (editor input filter)", () => {
  it("passes allowed characters, drops the rest", () => {
    expect(filterToBase32("AB 12 CD 34")).toBe("AB2CD34"); // spaces and '1' dropped; '2' kept
    expect(filterToBase32("Hello, World!")).toBe("HELLOWORLD");
  });

  it("uppercases lowercase input", () => {
    expect(filterToBase32("abc234")).toBe("ABC234");
  });
});
