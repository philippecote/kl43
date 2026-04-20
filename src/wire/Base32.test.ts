import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BASE32_ALPHABET,
  BASE32_ERASURE_MARKER,
  Base32Error,
  base32Decode,
  base32Encode,
  filterToBase32,
  filterToBase32PreservingErasures,
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

  it("drops the '?' erasure marker (editor contract)", () => {
    // The editor's silent-drop filter must not leak modem-emitted '?'
    // markers into an operator's hand-typed ciphertext entry.
    expect(filterToBase32("AB?CD")).toBe("ABCD");
  });
});

describe("filterToBase32PreservingErasures (receive-side filter)", () => {
  it("is literally the erasure marker", () => {
    expect(BASE32_ERASURE_MARKER).toBe("?");
  });

  it("maps '?' to 'A' at the same position (single)", () => {
    expect(filterToBase32PreservingErasures("AB?DE")).toBe("ABADE");
  });

  it("preserves length with repeated '?' in the body", () => {
    const input = "A?B?C?";
    const out = filterToBase32PreservingErasures(input);
    expect(out.length).toBe(input.length);
    expect(out).toBe("AABACA");
  });

  it("drops spaces / newlines / tabs / dashes / '=' pad silently (structural, no position info)", () => {
    // Grouping spaces come from `groupForDisplay`; they carry no
    // positional information so dropping them doesn't shift the base32
    // stream. '=' is the RFC 4648 pad char, also formatting-only.
    // Dashes are the conventional hand-copy separator ("ABC-DEF-GHI")
    // and can only reach this filter on the hand-entry path — the
    // modem RX path converts any '-' to '?' upstream.
    expect(filterToBase32PreservingErasures("ABC DEF")).toBe("ABCDEF");
    expect(filterToBase32PreservingErasures("ABC\nDEF")).toBe("ABCDEF");
    expect(filterToBase32PreservingErasures("ABC\tDEF")).toBe("ABCDEF");
    expect(filterToBase32PreservingErasures("ABC\r\nDEF")).toBe("ABCDEF");
    expect(filterToBase32PreservingErasures("ABC-DEF-GHI")).toBe("ABCDEFGHI");
    expect(filterToBase32PreservingErasures("ABCDEFGH====")).toBe("ABCDEFGH");
  });

  it("maps off-alphabet printables to 'A' at the same position (defensive)", () => {
    // This is the new defensive behaviour: any character that is neither
    // a valid base32 symbol, nor formatting whitespace/padding, gets
    // mapped to 'A'. This keeps the receive-side filter byte-aligned
    // even when a stray '\\', ';', '!', digit outside 2-7, etc. slips
    // through. Silent drops here would cascade into RS misalignment.
    expect(filterToBase32PreservingErasures("AB\\DE")).toBe("ABADE");
    expect(filterToBase32PreservingErasures("AB;DE")).toBe("ABADE");
    expect(filterToBase32PreservingErasures("AB!DE")).toBe("ABADE");
    expect(filterToBase32PreservingErasures("A1B0C")).toBe("AABAC");
  });

  it("uppercases valid base32 characters", () => {
    expect(filterToBase32PreservingErasures("abc234")).toBe("ABC234");
  });

  it("handles all-'?' input as all 'A's (all-zero-bit worst case)", () => {
    expect(filterToBase32PreservingErasures("????")).toBe("AAAA");
  });

  it("preserves length modulo structural-character removal", () => {
    // After stripping structural chars (whitespace / pad / hand-copy
    // dash), each remaining input character maps to exactly one
    // output character. This is what guarantees byte alignment
    // downstream.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        (s) => {
          const upper = s.toUpperCase();
          const structuralCount =
            [...upper].filter(
              (c) =>
                c === " " ||
                c === "\n" ||
                c === "\r" ||
                c === "\t" ||
                c === "-" ||
                c === "=",
            ).length;
          expect(filterToBase32PreservingErasures(s).length).toBe(
            upper.length - structuralCount,
          );
        },
      ),
    );
  });

  it("each '?' shifts at most one output symbol away from the strict filter (valid alphabet only)", () => {
    // Invariant that makes the RS argument work: inserting a '?' into
    // an otherwise valid base32 sequence should only flip one symbol
    // (the 'A' standing in for the lost byte), not shift the remaining
    // symbols.
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[A-Z2-7]*$/)
          .filter((s) => s.length >= 2)
          .map((s) => ({ s, i: s.length > 0 ? s.length >>> 1 : 0 })),
        ({ s, i }) => {
          const withErasure = s.slice(0, i) + "?" + s.slice(i);
          const out = filterToBase32PreservingErasures(withErasure);
          expect(out.length).toBe(s.length + 1);
          expect(out.slice(0, i)).toBe(s.slice(0, i));
          expect(out[i]).toBe("A");
          expect(out.slice(i + 1)).toBe(s.slice(i));
        },
      ),
    );
  });

  it("matches filterToBase32 only when the input contains no corruption chars", () => {
    // The two filters diverge: filterToBase32 silently drops any
    // non-alphabet char (suitable for an editor where the operator
    // chose what they're typing), while filterToBase32PreservingErasures
    // maps non-structural non-alphabet chars to 'A' (suitable for a
    // noisy wire). They only agree when the input contains only
    // base32 + structural chars.
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z2-7 \n\t=-]*$/),
        (s) => {
          expect(filterToBase32PreservingErasures(s)).toBe(filterToBase32(s));
        },
      ),
    );
  });
});
